// Background daemon: Unix socket server that receives JSON commands from CLI
// and dispatches to CDP command handlers
// Supports multiple concurrent CDP sessions via a session registry

import * as fs from "node:fs";
import * as net from "node:net";
import {
	CdpClientWrapper,
	discoverTarget,
	listTargets,
} from "@dbg/adapter-cdp";
import { DapClientWrapper } from "@dbg/adapter-dap";
import {
	ATTACH_PLATFORMS,
	AppleDeviceProviderError,
	listAppleAttachTargets,
	parseAttachRequest,
	resolveAppleDeviceAttachTarget,
} from "@dbg/provider-apple-device";
import { executeQuery, TableRegistry } from "@dbg/query";
import { EventStore } from "@dbg/store";
import { registerBrowserTables } from "@dbg/tables-browser";
import { registerCoreTables } from "@dbg/tables-core";
import { registerNativeTables } from "@dbg/tables-native";
import type {
	AttachDiagnostics,
	AttachPlatform,
	Command,
	CssCoverageEntry,
	DaemonState,
	DebugExecutor,
	JsCoverageScript,
	Response,
	Session,
	SessionInfo,
	StoredBreakpoint,
} from "@dbg/types";
import { SOCKET_PATH, createEmptyDebuggerState } from "@dbg/types";
import { executeAttachWithStrategy } from "./attach-strategy.js";
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

import type { ChildProcess } from "node:child_process";

// ─── State ───

function createState(): DaemonState {
	return createEmptyDebuggerState();
}

const store = new EventStore();
const tableRegistry = new TableRegistry();
registerCoreTables(tableRegistry);
registerBrowserTables(tableRegistry);
registerNativeTables(tableRegistry);

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

function asCdpExecutor(session: Session): CdpClientWrapper | null {
	return session.executor.protocol === "cdp"
		? (session.executor as CdpClientWrapper)
		: null;
}

function asDapExecutor(session: Session): DapClientWrapper | null {
	return session.executor.protocol === "dap"
		? (session.executor as DapClientWrapper)
		: null;
}

function findSessionByPid(pid: number): Session | null {
	for (const session of registry.sessions.values()) {
		if (!session.state.connected) continue;
		if (session.state.pid === pid) {
			return session;
		}
	}
	return null;
}

function formatAttachDiagnostics(diagnostics: AttachDiagnostics): string[] {
	const lines: string[] = [];
	lines.push(
		`attach strategy: requested=${diagnostics.requestedStrategy}, selected=${diagnostics.selectedStrategy ?? "none"}`,
	);
	lines.push(
		`attach timings: providerResolveMs=${diagnostics.providerResolveMs}, totalMs=${diagnostics.totalMs}`,
	);
	for (const attempt of diagnostics.attemptedStrategies) {
		lines.push(
			`attach attempt: strategy=${attempt.strategy}, success=${attempt.success}, durationMs=${attempt.durationMs}${attempt.error ? `, error=${attempt.error}` : ""}`,
		);
	}
	return lines;
}

function createEmptyAttachDiagnostics(
	requestedStrategy: AttachDiagnostics["requestedStrategy"],
	providerResolveMs: number,
): AttachDiagnostics {
	return {
		requestedStrategy,
		attemptedStrategies: [],
		selectedStrategy: null,
		providerResolveMs,
		totalMs: providerResolveMs,
	};
}

function isSimulatorAttachResolution(
	resolution: ReturnType<typeof resolveAppleDeviceAttachTarget>,
): boolean {
	return (
		String(resolution.metadata?.attachEnvironment ?? "").toLowerCase() ===
		"simulator"
	);
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
		if (state.cdp) {
			state.cdp.lastWsUrl = wsUrl;
		}

		const session: Session = {
			name,
			state,
			executor: cdp,
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
	await (
		session.executor as {
			disconnect?: () => Promise<void>;
		}
	).disconnect?.();
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
			executor: cdp,
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
		if (state.cdp) {
			state.cdp.lastWsUrl = discovered.wsUrl;
		}
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

async function handleAttach(
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

	let request: ReturnType<typeof parseAttachRequest>;
	try {
		request = parseAttachRequest(args);
	} catch (error) {
		return {
			ok: false,
			error: `invalid attach request: ${(error as Error).message}`,
		};
	}
	if (request.protocol && request.protocol !== "dap") {
		return {
			ok: false,
			error: `unsupported attach protocol '${request.protocol}'`,
		};
	}
	const requestedStrategy = request.attachStrategy ?? "auto";

	const state = createState();
	store.record(
		{
			source: "daemon",
			category: "connection",
			method: "apple.attach.start",
			data: request,
		},
		true,
	);

	const providerResolveStartedAt = Date.now();
	let resolution: ReturnType<typeof resolveAppleDeviceAttachTarget>;
	try {
		resolution = resolveAppleDeviceAttachTarget(request);
	} catch (error) {
		const providerResolveMs = Date.now() - providerResolveStartedAt;
		const diagnostics = createEmptyAttachDiagnostics(
			requestedStrategy,
			providerResolveMs,
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.diagnostics",
				data: diagnostics,
			},
			true,
		);
		if (error instanceof AppleDeviceProviderError) {
			store.record(
				{
					source: "daemon",
					category: "connection",
					method: "apple.attach.error",
					data: error.toProviderError(),
				},
				true,
			);
			return {
				ok: false,
				error: error.message,
				errorCode: error.code,
			};
		}
		return { ok: false, error: (error as Error).message };
	}

	const providerResolveMs = Date.now() - providerResolveStartedAt;

	const staleSession = findSessionByPid(resolution.pid);
	if (staleSession) {
		const diagnostics = createEmptyAttachDiagnostics(
			requestedStrategy,
			providerResolveMs,
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.diagnostics",
				data: diagnostics,
			},
			true,
		);
		const providerError = new AppleDeviceProviderError(
			"invalid_request",
			`pid ${resolution.pid} is already attached in session ${staleSession.name}`,
			{
				session: staleSession.name,
				pid: resolution.pid,
				bundleId: resolution.bundleId,
			},
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.error",
				data: providerError.toProviderError(),
			},
			true,
		);
		return {
			ok: false,
			error: providerError.message,
			errorCode: providerError.code,
		};
	}

	let attempt: Awaited<ReturnType<typeof executeAttachWithStrategy>>;
	try {
		attempt = await executeAttachWithStrategy({
			request,
			resolution,
			state,
			store,
			providerResolveMs,
		});
	} catch (error) {
		const diagnostics = createEmptyAttachDiagnostics(
			requestedStrategy,
			providerResolveMs,
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.diagnostics",
				data: diagnostics,
			},
			true,
		);
		const providerError = new AppleDeviceProviderError(
			"provider_error",
			"attach strategy execution failed unexpectedly",
			{
				originalError: (error as Error).message,
			},
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.error",
				data: providerError.toProviderError(),
			},
			true,
		);
		return {
			ok: false,
			error: providerError.message,
			errorCode: providerError.code,
		};
	}
	store.record(
		{
			source: "daemon",
			category: "connection",
			method: "apple.attach.diagnostics",
			data: attempt.diagnostics,
		},
		true,
	);

	if (!attempt.success) {
		await attempt.dap.disconnect();
		const providerError = new AppleDeviceProviderError(
			"attach_denied_or_timeout",
			"attach failed before debugger reached a debuggable stopped state",
			{
				hint: isSimulatorAttachResolution(resolution)
					? "Ensure the Simulator is booted, the app is running, and the process is attachable."
					: "Ensure no other debugger is attached, the app build permits debugger attach (get-task-allow), and CoreDevice tunnel/debugproxy is active for gdb-remote fallback.",
				originalError: attempt.error,
				diagnostics: attempt.diagnostics,
			},
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.error",
				data: providerError.toProviderError(),
			},
			true,
		);
		return {
			ok: false,
			error: `${providerError.message}. Last error: ${attempt.error ?? "unknown"}`,
			errorCode: providerError.code,
			phase: state.dap?.phase,
		};
	}

	const session: Session = {
		name,
		state,
		executor: attempt.dap,
		managedChild: null,
		targetType: "native",
		port: 0,
		host: resolution.deviceId,
		targetTitle: resolution.bundleId,
	};
	registry.sessions.set(name, session);
	registry.current = name;

	store.record(
		{
			source: "daemon",
			category: "connection",
			method: "apple.attach.success",
			data: {
				deviceId: resolution.deviceId,
				bundleId: resolution.bundleId,
				pid: resolution.pid,
				strategy: attempt.strategy,
				diagnostics: attempt.diagnostics,
			},
		},
		true,
	);

	const messages = [
		`attached ${resolution.bundleId} on ${resolution.deviceId} (pid ${resolution.pid})`,
	];
	if (request.verbose) {
		messages.push(...formatAttachDiagnostics(attempt.diagnostics));
	}

	return {
		ok: true,
		connected: true,
		status: state.paused ? "paused" : "running",
		pid: resolution.pid,
		s: name,
		messages,
	};
}

async function handleAttachLldb(
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

	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const programPath = tokens[0];
	if (!programPath) {
		return { ok: false, error: "usage: attach-lldb <program-path>" };
	}

	const state = createState();
	const dap = new DapClientWrapper(state, store);
	try {
		await dap.attachLldb({
			programPath,
			args: tokens.slice(1),
		});

		const session: Session = {
			name,
			state,
			executor: dap,
			managedChild: null,
			targetType: "native",
			port: 0,
			host: "localhost",
			targetTitle: programPath,
		};
		registry.sessions.set(name, session);
		registry.current = name;
		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			phase: state.dap?.phase,
			s: name,
			messages: [`attached lldb to ${programPath}`],
		};
	} catch (error) {
		await dap.disconnect();
		return {
			ok: false,
			error: (error as Error).message,
			errorCode: parseErrorCode(error),
			phase: state.dap?.phase,
		};
	}
}

async function handleRestart(session: Session): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "restart is only supported for cdp sessions" };
	}
	if (!session.state.managedCommand) {
		return { ok: false, error: "no managed process to restart" };
	}

	const command = session.state.managedCommand;
	const savedBreakpoints = Array.from(session.state.breakpoints.values());

	// Disconnect and kill
	await cdp.disconnect();
	if (session.managedChild) {
		killTarget(session.managedChild);
		session.managedChild = null;
	}

	// Reset state but remember the command
	session.state = createState();
	session.state.managedCommand = command;
	session.executor = new CdpClientWrapper(session.state, store);
	const nextCdp = asCdpExecutor(session);
	if (!nextCdp) {
		return { ok: false, error: "failed to initialize cdp executor" };
	}

	// Respawn
	try {
		const { child, port } = await spawnTarget(command);
		session.managedChild = child;
		session.state.pid = child.pid ?? null;
		session.port = port;

		child.on("exit", () => {
			session.managedChild = null;
			session.state.pid = null;
			void nextCdp.disconnect();
		});

		const discovered = await discoverTarget(port);
		await nextCdp.connect(discovered.wsUrl, discovered.type);
		if (session.state.cdp) {
			session.state.cdp.lastWsUrl = discovered.wsUrl;
		}
		session.targetType = discovered.type;

		// Re-apply breakpoints using setBreakpointByUrl so they auto-apply
		// when matching scripts load (we're paused at line 0, scripts not loaded yet)
		const restored: string[] = [];
		for (const bp of savedBreakpoints) {
			try {
				const urlRegex = `.*${bp.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
				const result = (await nextCdp.send("Debugger.setBreakpointByUrl", {
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

// ─── Apple device/simulator listing ───

async function handleDevices(args?: string): Promise<Response> {
	let platform: AttachPlatform = "auto";
	if (args?.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(args);
		} catch {
			return {
				ok: false,
				error: "invalid devices args: expected JSON { platform?: string }",
			};
		}
		if (parsed && typeof parsed === "object" && "platform" in parsed) {
			const value = (parsed as { platform?: unknown }).platform;
			if (typeof value === "string" && value.trim()) {
				const next = value.trim() as AttachPlatform;
				if (!ATTACH_PLATFORMS.includes(next)) {
					return {
						ok: false,
						error: `unsupported platform '${value.trim()}'. Supported: ${ATTACH_PLATFORMS.join(", ")}`,
					};
				}
				platform = next;
			}
		}
	}

	try {
		const targets = listAppleAttachTargets(platform);
		return {
			ok: true,
			columns: [
				"kind",
				"platform",
				"booted",
				"identifier",
				"udid",
				"name",
				"runtime",
			],
			rows: targets.map((t) => [
				t.kind,
				t.platform,
				t.booted,
				t.identifier,
				t.udid ?? "",
				t.name,
				t.runtime ?? "",
			]),
		};
	} catch (error) {
		if (error instanceof AppleDeviceProviderError) {
			return {
				ok: false,
				error: error.message,
				errorCode: error.code,
			};
		}
		return { ok: false, error: (error as Error).message };
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
			protocol: session.executor.protocol,
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
			"protocol",
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
			i.protocol,
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (args === "reload") {
		await cdp.send("Page.reload", {});
		return { ok: true, messages: ["reloading"] };
	}

	if (args === "back") {
		const history = (await cdp.send("Page.getNavigationHistory", {})) as {
			currentIndex: number;
			entries: Array<{ id: number; url: string }>;
		};
		if (history.currentIndex > 0) {
			const entry = history.entries[history.currentIndex - 1];
			await cdp.send("Page.navigateToHistoryEntry", {
				entryId: entry.id,
			});
			return { ok: true, messages: [`navigated back to ${entry.url}`] };
		}
		return { ok: false, error: "no previous history entry" };
	}

	if (args === "forward") {
		const history = (await cdp.send("Page.getNavigationHistory", {})) as {
			currentIndex: number;
			entries: Array<{ id: number; url: string }>;
		};
		if (history.currentIndex < history.entries.length - 1) {
			const entry = history.entries[history.currentIndex + 1];
			await cdp.send("Page.navigateToHistoryEntry", {
				entryId: entry.id,
			});
			return { ok: true, messages: [`navigated forward to ${entry.url}`] };
		}
		return { ok: false, error: "no forward history entry" };
	}

	// URL navigation
	const result = (await cdp.send("Page.navigate", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const result = (await cdp.send("Page.captureScreenshot", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const selector = args.trim();
	if (!selector) {
		return { ok: false, error: "selector required" };
	}

	try {
		// Get document root
		const doc = (await cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		// Find element
		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Get box model for click coordinates
		const box = (await cdp.send("DOM.getBoxModel", {
			nodeId: found.nodeId,
		})) as { model: { content: number[] } };

		// content quad: [x1,y1, x2,y1, x2,y2, x1,y2]
		const quad = box.model.content;
		const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
		const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

		// Dispatch mouse events
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y,
		});
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
		await cdp.send("Input.dispatchMouseEvent", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
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
		const doc = (await cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Focus the element
		await cdp.send("DOM.focus", { nodeId: found.nodeId });

		// Type each character
		for (const char of text) {
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				text: char,
			});
			await cdp.send("Input.dispatchKeyEvent", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
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
		const doc = (await cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Resolve to JS object
		const resolved = (await cdp.send("DOM.resolveNode", {
			nodeId: found.nodeId,
		})) as { object: { objectId: string } };

		// Set value and dispatch change event
		const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		await cdp.send("Runtime.callFunctionOn", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
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
	cdp.addMockRule(urlPattern, body, statusCode);

	// Enable Fetch interception if not already enabled
	try {
		await cdp.send("Fetch.enable", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (pattern) {
		const removed = cdp.removeMockRule(pattern);
		if (!removed) {
			return { ok: false, error: `no mock rule for: ${pattern}` };
		}
		if (cdp.getMockRules().size === 0) {
			try {
				await cdp.send("Fetch.disable", {});
			} catch {
				// ignore
			}
		}
		return { ok: true, messages: [`removed mock for ${pattern}`] };
	}

	// Clear all
	cdp.clearMockRules();
	try {
		await cdp.send("Fetch.disable", {});
	} catch {
		// ignore
	}
	return { ok: true, messages: ["all mocks cleared"] };
}

async function handleEmulate(
	session: Session,
	args: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const preset = args.trim().toLowerCase();

	if (preset === "reset") {
		await cdp.send("Emulation.clearDeviceMetricsOverride", {});
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

	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: device.width,
		height: device.height,
		deviceScaleFactor: device.scale,
		mobile: device.mobile,
	});
	await cdp.send("Emulation.setUserAgentOverride", {
		userAgent: device.ua,
	});
	await cdp.send("Emulation.setTouchEmulationEnabled", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
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

	await cdp.send("Network.emulateNetworkConditions", {
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
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}
	if (!session.state.cdp) {
		return { ok: false, error: "missing cdp state" };
	}

	const action = args.trim().toLowerCase();

	if (action === "start") {
		session.state.cdp.coverageSnapshot = null;
		try {
			await cdp.send("Profiler.enable", {});
			await cdp.send("Profiler.startPreciseCoverage", {
				callCount: true,
				detailed: true,
			});
		} catch {
			// ignore profiler errors
		}
		try {
			await cdp.send("CSS.startRuleUsageTracking", {});
		} catch {
			// ignore CSS errors
		}
		return { ok: true, messages: ["coverage tracking started"] };
	}

	if (action === "stop") {
		let jsSnapshot: JsCoverageScript[] = [];
		let cssSnapshot: CssCoverageEntry[] = [];

		try {
			const jsResult = (await cdp.send("Profiler.takePreciseCoverage", {})) as {
				result: JsCoverageScript[];
			};
			jsSnapshot = jsResult.result ?? [];
		} catch {
			// ignore
		}
		try {
			const cssResult = (await cdp.send("CSS.takeCoverageDelta", {})) as {
				coverage: CssCoverageEntry[];
			};
			cssSnapshot = cssResult.coverage ?? [];
		} catch {
			// ignore
		}

		session.state.cdp.coverageSnapshot = {
			js: jsSnapshot,
			css: cssSnapshot,
			capturedAt: Date.now(),
		};

		try {
			await cdp.send("Profiler.stopPreciseCoverage", {});
			await cdp.send("Profiler.disable", {});
		} catch {
			// ignore
		}
		try {
			await cdp.send("CSS.stopRuleUsageTracking", {});
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
		let executor: DebugExecutor;
		if (session) {
			executor = session.executor;
		} else if (registry.sessions.size > 0) {
			const first = registry.sessions.values().next().value;
			executor = first
				? first.executor
				: new CdpClientWrapper(createState(), store);
		} else {
			const emptyState = createState();
			executor = new CdpClientWrapper(emptyState, store);
		}

		const result = await executeQuery(queryStr, executor, tableRegistry);
		return { ok: true, columns: result.columns, rows: result.rows };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function handleMemoryCommand(
	session: Session,
	args: string,
): Promise<Response> {
	const [address, lengthStr] = args.trim().split(/\s+/);
	if (!address || !lengthStr) {
		return { ok: false, error: "usage: memory <address> <length>" };
	}
	const length = Number.parseInt(lengthStr, 10);
	if (!Number.isFinite(length) || length <= 0) {
		return { ok: false, error: "length must be a positive integer" };
	}
	return handleQuery(
		`SELECT * FROM memory WHERE address = '${address}' AND length = ${length}`,
		session,
	);
}

async function handleDisasmCommand(
	session: Session,
	args?: string,
): Promise<Response> {
	const trimmed = (args ?? "").trim();
	if (!trimmed) {
		const frame = session.state.callFrames[0];
		if (!frame?.scriptId) {
			return { ok: false, error: "usage: disasm <address>" };
		}
		return handleQuery(
			`SELECT * FROM disassembly WHERE address = '${frame.scriptId}' LIMIT 32`,
			session,
		);
	}
	return handleQuery(
		`SELECT * FROM disassembly WHERE address = '${trimmed}' LIMIT 32`,
		session,
	);
}

// ─── Dispatch ───

async function dispatch(cmd: Command): Promise<Response> {
	const sessionName = cmd.s;

	switch (cmd.cmd) {
		case "devices":
			return handleDevices(cmd.args);
		case "open":
			return handleOpen(cmd.args, sessionName);
		case "attach-lldb":
			return handleAttachLldb(cmd.args, sessionName);
		case "attach":
			return handleAttach(cmd.args, sessionName);
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
			return handleStatus(session.executor, session.state);
		case "c":
			return handleContinue(session.executor, session.state);
		case "s":
			return handleStepInto(session.executor, session.state);
		case "n":
			return handleStepOver(session.executor, session.state);
		case "o":
			return handleStepOut(session.executor, session.state);
		case "pause":
			return handlePause(session.executor, session.state);
		case "b":
			return handleSetBreakpoint(session.executor, session.state, cmd.args);
		case "db":
			return handleDeleteBreakpoint(session.executor, session.state, cmd.args);
		case "bl":
			return handleListBreakpoints(session.executor, session.state);
		case "e":
			return handleEval(session.executor, session.state, cmd.args);
		case "src":
			return handleSource(session.executor, session.state, cmd.args);
		case "trace":
			return handleTrace(store, cmd.args);
		case "health":
			return handleHealth(session.executor, session.state);
		case "reconnect":
			return handleReconnect(
				session.executor,
				session.state,
				store,
				session.targetType === "native" ? undefined : session.targetType,
			);
		case "q":
			return handleQuery(cmd.args, session);
		case "navigate":
			if (!session.executor.capabilities.page) {
				return { ok: false, error: "requires browser session" };
			}
			return handleNavigate(session, cmd.args);
		case "screenshot":
			if (!session.executor.capabilities.page) {
				return { ok: false, error: "requires browser session" };
			}
			return handleScreenshot(session, cmd.args);
		case "click":
			if (!session.executor.capabilities.dom) {
				return { ok: false, error: "requires browser session" };
			}
			return handleClick(session, cmd.args);
		case "type":
			if (!session.executor.capabilities.dom) {
				return { ok: false, error: "requires browser session" };
			}
			return handleType(session, cmd.args);
		case "select":
			if (!session.executor.capabilities.dom) {
				return { ok: false, error: "requires browser session" };
			}
			return handleSelect(session, cmd.args);
		case "mock":
			if (!session.executor.capabilities.network) {
				return { ok: false, error: "requires browser session" };
			}
			return handleMock(session, cmd.args);
		case "unmock":
			if (!session.executor.capabilities.network) {
				return { ok: false, error: "requires browser session" };
			}
			return handleUnmock(session, cmd.args);
		case "emulate":
			if (!session.executor.capabilities.emulation) {
				return { ok: false, error: "requires browser session" };
			}
			return handleEmulate(session, cmd.args);
		case "throttle":
			if (!session.executor.capabilities.network) {
				return { ok: false, error: "requires browser session" };
			}
			return handleThrottle(session, cmd.args);
		case "coverage":
			if (!session.executor.capabilities.coverage) {
				return { ok: false, error: "requires browser session" };
			}
			return handleCoverage(session, cmd.args);
		case "registers":
			if (!session.executor.capabilities.registers) {
				return { ok: false, error: "requires LLDB session" };
			}
			return handleQuery("SELECT * FROM registers", session);
		case "memory":
			if (!session.executor.capabilities.memory) {
				return { ok: false, error: "requires LLDB session" };
			}
			return handleMemoryCommand(session, cmd.args);
		case "disasm":
			if (!session.executor.capabilities.disassembly) {
				return { ok: false, error: "requires LLDB session" };
			}
			return handleDisasmCommand(session, cmd.args);
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
			void (
				session.executor as {
					disconnect?: () => Promise<void>;
				}
			).disconnect?.();
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

function parseErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return undefined;
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && code ? code : undefined;
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
