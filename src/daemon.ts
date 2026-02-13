// Background daemon: Unix socket server that receives JSON commands from CLI
// and dispatches to CDP command handlers
// Supports multiple concurrent CDP sessions via a session registry

import * as fs from "node:fs";
import * as net from "node:net";
import { CdpClientWrapper } from "./cdp/client.js";
import { discoverTarget, listTargets } from "./cdp/discovery.js";
import {
	handleContinue,
	handleDeleteBreakpoint,
	handleEval,
	handleHealth,
	handleListBreakpoints,
	handlePause,
	handleReconnect,
	handleSetBreakpoint,
	handleSource,
	handleStatus,
	handleStepInto,
	handleStepOut,
	handleStepOver,
	handleTrace,
} from "./commands.js";
import { killTarget, spawnTarget } from "./process.js";
import type {
	Command,
	CssCoverageEntry,
	DaemonState,
	JsCoverageScript,
	Response,
	Session,
	SessionInfo,
	StoredBreakpoint,
} from "./protocol.js";
import { SOCKET_PATH } from "./protocol.js";
import { EventStore } from "./store.js";

import type { ChildProcess } from "node:child_process";

// ─── State ───

function createState(): DaemonState {
	return {
		connected: false,
		paused: false,
		pid: null,
		managedCommand: null,
		lastWsUrl: null,
		callFrames: [],
		asyncStackTrace: [],
		breakpoints: new Map(),
		scripts: new Map(),
		console: [],
		exceptions: [],
		networkRequests: new Map(),
		pageEvents: [],
		wsFrames: [],
		coverageSnapshot: null,
	};
}

const store = new EventStore();
const registry = {
	sessions: new Map<string, Session>(),
	current: null as string | null,
};

let sessionCounter = 0;

function nextSessionName(): string {
	while (registry.sessions.has(`s${sessionCounter}`)) {
		sessionCounter++;
	}
	return `s${sessionCounter++}`;
}

store.record(
	{
		source: "daemon",
		category: "lifecycle",
		method: "daemon.start",
		data: { pid: process.pid },
	},
	true,
);

// ─── Session resolution ───

function resolveSession(name?: string): Session | null {
	// Explicit name -> look up in map
	if (name) return registry.sessions.get(name) ?? null;
	// Only one session -> return it
	if (registry.sessions.size === 1)
		return registry.sessions.values().next().value ?? null;
	// Current set -> return that
	if (registry.current) return registry.sessions.get(registry.current) ?? null;
	// Otherwise null
	return null;
}

// ─── Lifecycle commands ───

async function handleOpen(
	args: string,
	sessionName?: string,
): Promise<Response> {
	const name = sessionName ?? nextSessionName();

	if (registry.sessions.has(name)) {
		return {
			ok: false,
			error: "session already exists; close it first",
		};
	}

	// Parse flags from args
	let remaining = args;
	let targetType: "node" | "page" | undefined;
	let targetId: string | undefined;

	const typeMatch = remaining.match(/--type\s+(node|page)/);
	if (typeMatch) {
		targetType = typeMatch[1] as "node" | "page";
		remaining = remaining.replace(typeMatch[0], "").trim();
	}

	const targetMatch = remaining.match(/--target\s+(\S+)/);
	if (targetMatch) {
		targetId = targetMatch[1];
		remaining = remaining.replace(targetMatch[0], "").trim();
	}

	let host = "127.0.0.1";
	let port: number;

	if (remaining.includes(":")) {
		const parts = remaining.split(":");
		host = parts[0];
		port = Number.parseInt(parts[1], 10);
	} else {
		port = Number.parseInt(remaining, 10);
	}

	if (Number.isNaN(port)) {
		return { ok: false, error: "invalid port" };
	}

	const state = createState();
	const cdp = new CdpClientWrapper(state, store);

	try {
		let wsUrl: string;
		let discoveredType: "node" | "page";

		if (targetId) {
			// Direct WebSocket connection to specific target
			wsUrl = `ws://${host}:${port}/devtools/page/${targetId}`;
			discoveredType = targetType ?? "page";
		} else {
			const discovered = await discoverTarget(port, host, targetType);
			wsUrl = discovered.wsUrl;
			discoveredType = discovered.type;
		}

		await cdp.connect(wsUrl, discoveredType);
		state.lastWsUrl = wsUrl;

		const session: Session = {
			name,
			state,
			cdp,
			managedChild: null,
			targetType: discoveredType,
			port,
			host,
		};

		// Store target info for session listing
		if (discoveredType === "page") {
			try {
				const targets = await listTargets(port, host);
				const matching = targets.find((t) => wsUrl.includes(t.id));
				if (matching) {
					session.targetUrl = matching.url;
					session.targetTitle = matching.title;
				}
			} catch {
				// ignore
			}
		}

		registry.sessions.set(name, session);
		registry.current = name;

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			s: name,
			messages: [`connected to ${host}:${port} (${discoveredType})`],
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function handleClose(session: Session): Promise<Response> {
	await session.cdp.disconnect();
	if (session.managedChild) {
		killTarget(session.managedChild);
		session.managedChild = null;
	}

	const prevPid = session.state.pid;
	const sessionName = session.name;
	registry.sessions.delete(sessionName);

	// Update current pointer
	if (registry.current === sessionName) {
		const firstRemaining = registry.sessions.keys().next().value;
		registry.current = firstRemaining ?? null;
	}

	return {
		ok: true,
		messages: [
			prevPid
				? `closed ${sessionName} (pid ${prevPid})`
				: `closed ${sessionName}`,
		],
	};
}

async function handleRun(
	command: string,
	sessionName?: string,
): Promise<Response> {
	const name = sessionName ?? nextSessionName();

	if (registry.sessions.has(name)) {
		return {
			ok: false,
			error: "session already exists; close it first",
		};
	}

	const state = createState();
	const cdp = new CdpClientWrapper(state, store);

	try {
		const { child, port } = await spawnTarget(command);
		state.pid = child.pid ?? null;
		state.managedCommand = command;

		const session: Session = {
			name,
			state,
			cdp,
			managedChild: child,
			targetType: "node",
			port,
			host: "127.0.0.1",
		};

		// Listen for process exit
		child.on("exit", () => {
			session.managedChild = null;
			state.pid = null;
			cdp.disconnect();
		});

		const discovered = await discoverTarget(port);
		await cdp.connect(discovered.wsUrl, discovered.type);
		state.lastWsUrl = discovered.wsUrl;
		session.targetType = discovered.type;

		registry.sessions.set(name, session);
		registry.current = name;

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			pid: state.pid ?? undefined,
			s: name,
			messages: [`spawned pid=${state.pid}, connected on port ${port}`],
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function handleRestart(session: Session): Promise<Response> {
	if (!session.state.managedCommand) {
		return { ok: false, error: "no managed process to restart" };
	}

	const command = session.state.managedCommand;
	const savedBreakpoints = Array.from(session.state.breakpoints.values());

	// Disconnect and kill
	await session.cdp.disconnect();
	if (session.managedChild) {
		killTarget(session.managedChild);
		session.managedChild = null;
	}

	// Reset state but remember the command
	session.state = createState();
	session.state.managedCommand = command;
	session.cdp = new CdpClientWrapper(session.state, store);

	// Respawn
	try {
		const { child, port } = await spawnTarget(command);
		session.managedChild = child;
		session.state.pid = child.pid ?? null;
		session.port = port;

		child.on("exit", () => {
			session.managedChild = null;
			session.state.pid = null;
			session.cdp.disconnect();
		});

		const discovered = await discoverTarget(port);
		await session.cdp.connect(discovered.wsUrl, discovered.type);
		session.state.lastWsUrl = discovered.wsUrl;
		session.targetType = discovered.type;

		// Re-apply breakpoints using setBreakpointByUrl so they auto-apply
		// when matching scripts load (we're paused at line 0, scripts not loaded yet)
		const restored: string[] = [];
		for (const bp of savedBreakpoints) {
			try {
				const urlRegex = `.*${bp.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
				const result = (await session.cdp.send("Debugger.setBreakpointByUrl", {
					lineNumber: bp.line,
					urlRegex,
					columnNumber: 0,
					...(bp.condition ? { condition: bp.condition } : {}),
				})) as {
					breakpointId: string;
					locations: Array<{
						scriptId: string;
						lineNumber: number;
						columnNumber: number;
					}>;
				};
				const newBp: StoredBreakpoint = {
					id: result.breakpointId,
					file: bp.file,
					line: result.locations[0]?.lineNumber ?? bp.line,
					condition: bp.condition,
					hits: 0,
					enabled: true,
					cdpBreakpointId: result.breakpointId,
				};
				session.state.breakpoints.set(result.breakpointId, newBp);
				restored.push(result.breakpointId);
			} catch {
				// Skip breakpoints that can't be restored
			}
		}

		return {
			ok: true,
			connected: true,
			status: session.state.paused ? "paused" : "running",
			pid: session.state.pid ?? undefined,
			s: session.name,
			messages: [
				`restarted pid=${session.state.pid}`,
				`restored ${restored.length}/${savedBreakpoints.length} breakpoints`,
			],
		};
	} catch (e) {
		return { ok: false, error: `restart failed: ${(e as Error).message}` };
	}
}

// ─── Target listing ───

async function handleTargets(args: string): Promise<Response> {
	let host = "127.0.0.1";
	let port: number;

	if (args.includes(":")) {
		const parts = args.split(":");
		host = parts[0];
		port = Number.parseInt(parts[1], 10);
	} else {
		port = Number.parseInt(args, 10);
	}

	if (Number.isNaN(port)) {
		return { ok: false, error: "invalid port" };
	}

	try {
		const targets = await listTargets(port, host);
		return {
			ok: true,
			columns: ["id", "type", "title", "url"],
			rows: targets.map((t) => [t.id, t.type, t.title, t.url]),
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

// ─── Session management commands ───

async function handleSessions(): Promise<Response> {
	const infos: SessionInfo[] = [];
	for (const [name, session] of registry.sessions) {
		infos.push({
			name,
			connected: session.state.connected,
			paused: session.state.paused,
			targetType: session.targetType,
			port: session.port,
			host: session.host,
			pid: session.state.pid,
			current: name === registry.current,
			targetUrl: session.targetUrl,
			targetTitle: session.targetTitle,
		});
	}
	return {
		ok: true,
		columns: [
			"name",
			"connected",
			"paused",
			"type",
			"port",
			"host",
			"pid",
			"current",
			"url",
			"title",
		],
		rows: infos.map((i) => [
			i.name,
			i.connected,
			i.paused,
			i.targetType,
			i.port,
			i.host,
			i.pid,
			i.current,
			i.targetUrl ?? "",
			i.targetTitle ?? "",
		]),
		sessions: infos,
	};
}

async function handleUse(name: string): Promise<Response> {
	if (!registry.sessions.has(name)) {
		return { ok: false, error: `no session named "${name}"` };
	}
	registry.current = name;
	return { ok: true, messages: [`current session: ${name}`] };
}

// ─── Browser commands ───

async function handleNavigate(
	session: Session,
	args: string,
): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (args === "reload") {
		await session.cdp.send("Page.reload", {});
		return { ok: true, messages: ["reloading"] };
	}

	if (args === "back") {
		const history = (await session.cdp.send(
			"Page.getNavigationHistory",
			{},
		)) as { currentIndex: number; entries: Array<{ id: number; url: string }> };
		if (history.currentIndex > 0) {
			const entry = history.entries[history.currentIndex - 1];
			await session.cdp.send("Page.navigateToHistoryEntry", {
				entryId: entry.id,
			});
			return { ok: true, messages: [`navigated back to ${entry.url}`] };
		}
		return { ok: false, error: "no previous history entry" };
	}

	if (args === "forward") {
		const history = (await session.cdp.send(
			"Page.getNavigationHistory",
			{},
		)) as { currentIndex: number; entries: Array<{ id: number; url: string }> };
		if (history.currentIndex < history.entries.length - 1) {
			const entry = history.entries[history.currentIndex + 1];
			await session.cdp.send("Page.navigateToHistoryEntry", {
				entryId: entry.id,
			});
			return { ok: true, messages: [`navigated forward to ${entry.url}`] };
		}
		return { ok: false, error: "no forward history entry" };
	}

	// URL navigation
	const result = (await session.cdp.send("Page.navigate", {
		url: args,
	})) as { frameId: string; errorText?: string };

	if (result.errorText) {
		return { ok: false, error: `navigation failed: ${result.errorText}` };
	}

	return { ok: true, messages: [`navigated to ${args}`] };
}

async function handleScreenshot(
	session: Session,
	filePath?: string,
): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const result = (await session.cdp.send("Page.captureScreenshot", {
		format: "png",
	})) as { data: string };

	if (filePath) {
		const fsPromises = await import("node:fs/promises");
		const buffer = Buffer.from(result.data, "base64");
		await fsPromises.writeFile(filePath, buffer);
		return {
			ok: true,
			messages: [`screenshot saved to ${filePath} (${buffer.length} bytes)`],
		};
	}

	// Return base64 data for agent consumption
	return { ok: true, data: result.data, messages: ["screenshot captured"] };
}

async function handleClick(session: Session, args: string): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const selector = args.trim();
	if (!selector) {
		return { ok: false, error: "selector required" };
	}

	try {
		// Get document root
		const doc = (await session.cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		// Find element
		const found = (await session.cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Get box model for click coordinates
		const box = (await session.cdp.send("DOM.getBoxModel", {
			nodeId: found.nodeId,
		})) as { model: { content: number[] } };

		// content quad: [x1,y1, x2,y1, x2,y2, x1,y2]
		const quad = box.model.content;
		const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
		const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

		// Dispatch mouse events
		await session.cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y,
		});
		await session.cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
		await session.cdp.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			clickCount: 1,
		});

		return {
			ok: true,
			messages: [`clicked ${selector} at (${Math.round(x)}, ${Math.round(y)})`],
		};
	} catch (e) {
		return { ok: false, error: `click failed: ${(e as Error).message}` };
	}
}

async function handleType(session: Session, args: string): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	// Parse: "selector" "text" or selector text
	const match =
		args.match(/^"([^"]+)"\s+"([^"]*)"$/) ||
		args.match(/^"([^"]+)"\s+(.+)$/) ||
		args.match(/^(\S+)\s+"([^"]*)"$/) ||
		args.match(/^(\S+)\s+(.+)$/);

	if (!match) {
		return { ok: false, error: 'usage: type "selector" "text"' };
	}

	const selector = match[1];
	const text = match[2];

	try {
		// Get document and find element
		const doc = (await session.cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		const found = (await session.cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Focus the element
		await session.cdp.send("DOM.focus", { nodeId: found.nodeId });

		// Type each character
		for (const char of text) {
			await session.cdp.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				text: char,
			});
			await session.cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				text: char,
			});
		}

		return {
			ok: true,
			messages: [`typed ${text.length} chars into ${selector}`],
		};
	} catch (e) {
		return { ok: false, error: `type failed: ${(e as Error).message}` };
	}
}

async function handleSelect(session: Session, args: string): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	// Parse: "selector" "value"
	const match =
		args.match(/^"([^"]+)"\s+"([^"]*)"$/) ||
		args.match(/^"([^"]+)"\s+(.+)$/) ||
		args.match(/^(\S+)\s+"([^"]*)"$/) ||
		args.match(/^(\S+)\s+(.+)$/);

	if (!match) {
		return { ok: false, error: 'usage: select "selector" "value"' };
	}

	const selector = match[1];
	const value = match[2];

	try {
		// Find element and set value via Runtime
		const doc = (await session.cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		const found = (await session.cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Resolve to JS object
		const resolved = (await session.cdp.send("DOM.resolveNode", {
			nodeId: found.nodeId,
		})) as { object: { objectId: string } };

		// Set value and dispatch change event
		const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		await session.cdp.send("Runtime.callFunctionOn", {
			objectId: resolved.object.objectId,
			functionDeclaration: `function() { this.value = '${escapedValue}'; this.dispatchEvent(new Event('change', { bubbles: true })); this.dispatchEvent(new Event('input', { bubbles: true })); }`,
			returnByValue: true,
		});

		return {
			ok: true,
			messages: [`selected "${value}" in ${selector}`],
		};
	} catch (e) {
		return { ok: false, error: `select failed: ${(e as Error).message}` };
	}
}

// ─── Mock / Emulate / Throttle / Coverage ───

async function handleMock(session: Session, args: string): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	// Parse: url-pattern json-body [--status code]
	let statusCode = 200;
	let remaining = args;

	const statusMatch = remaining.match(/--status\s+(\d+)/);
	if (statusMatch) {
		statusCode = Number.parseInt(statusMatch[1], 10);
		remaining = remaining.replace(statusMatch[0], "").trim();
	}

	// Split into pattern and body
	const parts = remaining.match(/^(\S+)\s+(.+)$/);
	if (!parts) {
		return {
			ok: false,
			error: "usage: mock <url-pattern> <json-body> [--status <code>]",
		};
	}

	const urlPattern = parts[1];
	const body = parts[2];

	// Add mock rule
	session.cdp.addMockRule(urlPattern, body, statusCode);

	// Enable Fetch interception if not already enabled
	try {
		await session.cdp.send("Fetch.enable", {
			patterns: [{ urlPattern: "*" }],
		});
	} catch {
		// May already be enabled
	}

	return {
		ok: true,
		messages: [`mocking ${urlPattern} → ${statusCode} (${body.length} chars)`],
	};
}

async function handleUnmock(
	session: Session,
	pattern?: string,
): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (pattern) {
		const removed = session.cdp.removeMockRule(pattern);
		if (!removed) {
			return { ok: false, error: `no mock rule for: ${pattern}` };
		}
		if (session.cdp.getMockRules().size === 0) {
			try {
				await session.cdp.send("Fetch.disable", {});
			} catch {
				// ignore
			}
		}
		return { ok: true, messages: [`removed mock for ${pattern}`] };
	}

	// Clear all
	session.cdp.clearMockRules();
	try {
		await session.cdp.send("Fetch.disable", {});
	} catch {
		// ignore
	}
	return { ok: true, messages: ["all mocks cleared"] };
}

async function handleEmulate(
	session: Session,
	args: string,
): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const preset = args.trim().toLowerCase();

	if (preset === "reset") {
		await session.cdp.send("Emulation.clearDeviceMetricsOverride", {});
		return { ok: true, messages: ["emulation reset"] };
	}

	// Device presets
	const devices: Record<
		string,
		{
			width: number;
			height: number;
			scale: number;
			mobile: boolean;
			ua: string;
		}
	> = {
		"iphone-14": {
			width: 390,
			height: 844,
			scale: 3,
			mobile: true,
			ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
		},
		"iphone-se": {
			width: 375,
			height: 667,
			scale: 2,
			mobile: true,
			ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
		},
		ipad: {
			width: 810,
			height: 1080,
			scale: 2,
			mobile: true,
			ua: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
		},
		"pixel-7": {
			width: 412,
			height: 915,
			scale: 2.625,
			mobile: true,
			ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
		},
	};

	const device = devices[preset];
	if (!device) {
		const available = Object.keys(devices).join(", ");
		return {
			ok: false,
			error: `unknown device: ${preset}. Available: ${available}, reset`,
		};
	}

	await session.cdp.send("Emulation.setDeviceMetricsOverride", {
		width: device.width,
		height: device.height,
		deviceScaleFactor: device.scale,
		mobile: device.mobile,
	});
	await session.cdp.send("Emulation.setUserAgentOverride", {
		userAgent: device.ua,
	});
	await session.cdp.send("Emulation.setTouchEmulationEnabled", {
		enabled: device.mobile,
	});

	return {
		ok: true,
		messages: [`emulating ${preset} (${device.width}x${device.height})`],
	};
}

async function handleThrottle(
	session: Session,
	args: string,
): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const preset = args.trim().toLowerCase();

	const presets: Record<
		string,
		{ latency: number; download: number; upload: number }
	> = {
		"3g": { latency: 100, download: 750 * 1024, upload: 250 * 1024 },
		"slow-3g": { latency: 2000, download: 50 * 1024, upload: 50 * 1024 },
		"fast-3g": {
			latency: 562,
			download: 180 * 1024,
			upload: 84.375 * 1024,
		},
		"4g": {
			latency: 20,
			download: 4 * 1024 * 1024,
			upload: 3 * 1024 * 1024,
		},
		offline: { latency: 0, download: 0, upload: 0 },
		off: { latency: 0, download: -1, upload: -1 },
	};

	const conditions = presets[preset];
	if (!conditions) {
		const available = Object.keys(presets).join(", ");
		return {
			ok: false,
			error: `unknown preset: ${preset}. Available: ${available}`,
		};
	}

	await session.cdp.send("Network.emulateNetworkConditions", {
		offline: preset === "offline",
		latency: conditions.latency,
		downloadThroughput: conditions.download,
		uploadThroughput: conditions.upload,
	});

	return {
		ok: true,
		messages: [
			preset === "off"
				? "network throttling disabled"
				: `network throttled to ${preset}`,
		],
	};
}

async function handleCoverage(
	session: Session,
	args: string,
): Promise<Response> {
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const action = args.trim().toLowerCase();

	if (action === "start") {
		session.state.coverageSnapshot = null;
		try {
			await session.cdp.send("Profiler.enable", {});
			await session.cdp.send("Profiler.startPreciseCoverage", {
				callCount: true,
				detailed: true,
			});
		} catch {
			// ignore profiler errors
		}
		try {
			await session.cdp.send("CSS.startRuleUsageTracking", {});
		} catch {
			// ignore CSS errors
		}
		return { ok: true, messages: ["coverage tracking started"] };
	}

	if (action === "stop") {
		let jsSnapshot: JsCoverageScript[] = [];
		let cssSnapshot: CssCoverageEntry[] = [];

		try {
			const jsResult = (await session.cdp.send(
				"Profiler.takePreciseCoverage",
				{},
			)) as {
				result: JsCoverageScript[];
			};
			jsSnapshot = jsResult.result ?? [];
		} catch {
			// ignore
		}
		try {
			const cssResult = (await session.cdp.send(
				"CSS.takeCoverageDelta",
				{},
			)) as {
				coverage: CssCoverageEntry[];
			};
			cssSnapshot = cssResult.coverage ?? [];
		} catch {
			// ignore
		}

		session.state.coverageSnapshot = {
			js: jsSnapshot,
			css: cssSnapshot,
			capturedAt: Date.now(),
		};

		try {
			await session.cdp.send("Profiler.stopPreciseCoverage", {});
			await session.cdp.send("Profiler.disable", {});
		} catch {
			// ignore
		}
		try {
			await session.cdp.send("CSS.stopRuleUsageTracking", {});
		} catch {
			// ignore
		}
		return {
			ok: true,
			messages: [
				"coverage tracking stopped (query coverage table for results)",
			],
		};
	}

	return { ok: false, error: "usage: coverage start|stop" };
}

// ─── Query ───

async function handleQuery(
	queryStr: string,
	session: Session | null,
): Promise<Response> {
	try {
		// Dynamic import -- the query engine may not exist yet
		const mod = (await import("./query/engine.js")) as {
			executeQuery: (
				query: string,
				executor: CdpClientWrapper,
			) => Promise<{ columns: string[]; rows: unknown[][] }>;
		};

		// Determine which executor to use
		let executor: CdpClientWrapper;
		if (session) {
			executor = session.cdp;
		} else if (registry.sessions.size > 0) {
			// No explicit session; use first available session's cdp
			const first = registry.sessions.values().next().value;
			executor = first ? first.cdp : new CdpClientWrapper(createState(), store);
		} else {
			// No sessions at all; create a minimal executor with empty state and the store
			const emptyState = createState();
			executor = new CdpClientWrapper(emptyState, store);
		}

		const result = await mod.executeQuery(queryStr, executor);
		return { ok: true, columns: result.columns, rows: result.rows };
	} catch (e) {
		const msg = (e as Error).message;
		if (
			msg.includes("Cannot find module") ||
			msg.includes("MODULE_NOT_FOUND")
		) {
			return { ok: false, error: "query engine not available" };
		}
		return { ok: false, error: msg };
	}
}

// ─── Dispatch ───

async function dispatch(cmd: Command): Promise<Response> {
	const sessionName = cmd.s;

	switch (cmd.cmd) {
		case "open":
			return handleOpen(cmd.args, sessionName);
		case "run":
			return handleRun(cmd.args, sessionName);
		case "ss":
			return handleSessions();
		case "use":
			return handleUse(cmd.args);
		case "targets":
			return handleTargets(cmd.args);
		default: {
			// Commands that work without sessions
			if (cmd.cmd === "close" && registry.sessions.size === 0) {
				return { ok: true, messages: ["no sessions to close"] };
			}
			if (cmd.cmd === "status" && registry.sessions.size === 0) {
				return { ok: true, connected: false };
			}
			if (cmd.cmd === "health" && registry.sessions.size === 0) {
				return { ok: false, error: "not connected" };
			}
			if (cmd.cmd === "q") {
				if (sessionName && !registry.sessions.has(sessionName)) {
					return { ok: false, error: `unknown session: ${sessionName}` };
				}
				return handleQuery(cmd.args, resolveSession(sessionName));
			}

			const session = resolveSession(sessionName);
			if (!session) {
				if (registry.sessions.size === 0) {
					return {
						ok: false,
						error: "no active session; use open or run first",
					};
				}
				return {
					ok: false,
					error: "multiple sessions; specify @name or use <name>",
				};
			}

			return dispatchToSession(cmd, session);
		}
	}
}

async function dispatchToSession(
	cmd: Command,
	session: Session,
): Promise<Response> {
	switch (cmd.cmd) {
		case "close":
			return handleClose(session);
		case "restart":
			return handleRestart(session);
		case "status":
			return handleStatus(session.cdp, session.state);
		case "c":
			return handleContinue(session.cdp, session.state);
		case "s":
			return handleStepInto(session.cdp, session.state);
		case "n":
			return handleStepOver(session.cdp, session.state);
		case "o":
			return handleStepOut(session.cdp, session.state);
		case "pause":
			return handlePause(session.cdp, session.state);
		case "b":
			return handleSetBreakpoint(session.cdp, session.state, cmd.args);
		case "db":
			return handleDeleteBreakpoint(session.cdp, session.state, cmd.args);
		case "bl":
			return handleListBreakpoints(session.cdp, session.state);
		case "e":
			return handleEval(session.cdp, session.state, cmd.args);
		case "src":
			return handleSource(session.cdp, session.state, cmd.args);
		case "trace":
			return handleTrace(store, cmd.args);
		case "health":
			return handleHealth(session.cdp, session.state);
		case "reconnect":
			return handleReconnect(
				session.cdp,
				session.state,
				store,
				session.targetType,
			);
		case "q":
			return handleQuery(cmd.args, session);
		case "navigate":
			return handleNavigate(session, cmd.args);
		case "screenshot":
			return handleScreenshot(session, cmd.args);
		case "click":
			return handleClick(session, cmd.args);
		case "type":
			return handleType(session, cmd.args);
		case "select":
			return handleSelect(session, cmd.args);
		case "mock":
			return handleMock(session, cmd.args);
		case "unmock":
			return handleUnmock(session, cmd.args);
		case "emulate":
			return handleEmulate(session, cmd.args);
		case "throttle":
			return handleThrottle(session, cmd.args);
		case "coverage":
			return handleCoverage(session, cmd.args);
		default:
			return {
				ok: false,
				error: `unknown command: ${(cmd as { cmd: string }).cmd}`,
			};
	}
}

// ─── Socket server ───

function startServer(): void {
	// Clean up stale socket
	try {
		fs.unlinkSync(SOCKET_PATH);
	} catch {
		// doesn't exist, fine
	}

	const server = net.createServer((socket) => {
		let buffer = "";

		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			// Process complete lines
			while (true) {
				const newlineIdx = buffer.indexOf("\n");
				if (newlineIdx === -1) break;
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				if (!line.trim()) continue;
				processLine(socket, line);
			}
		});

		socket.on("error", () => {
			// Client disconnected, ignore
		});
	});

	server.listen(SOCKET_PATH, () => {
		// Write PID to stdout so the CLI knows we launched
		process.stdout.write(`${process.pid}\n`);
		// Detach stdout/stderr after writing PID
		if (process.stdout.unref) process.stdout.unref();
	});

	server.on("error", (err) => {
		process.stderr.write(`daemon server error: ${err.message}\n`);
		process.exit(1);
	});

	// Cleanup on exit
	function cleanup() {
		store.record(
			{
				source: "daemon",
				category: "lifecycle",
				method: "daemon.stop",
				data: { pid: process.pid },
			},
			true,
		);
		try {
			fs.unlinkSync(SOCKET_PATH);
		} catch {
			// ignore
		}
		for (const session of registry.sessions.values()) {
			if (session.managedChild) {
				killTarget(session.managedChild);
			}
			session.cdp.disconnect();
		}
		registry.sessions.clear();
		store.close();
		server.close();
	}

	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("uncaughtException", (err) => {
		process.stderr.write(`daemon uncaught: ${err.message}\n`);
		cleanup();
		process.exit(1);
	});
}

function processLine(socket: net.Socket, line: string): void {
	let cmd: Command;
	try {
		cmd = JSON.parse(line) as Command;
	} catch {
		sendResponse(socket, { ok: false, error: "invalid JSON" });
		return;
	}

	dispatch(cmd)
		.then((response) => {
			sendResponse(socket, response);
		})
		.catch((err) => {
			sendResponse(socket, {
				ok: false,
				error: `dispatch error: ${(err as Error).message}`,
			});
		});
}

function sendResponse(socket: net.Socket, response: Response): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// Client already gone
	}
}

// ─── Entry point ───

startServer();
