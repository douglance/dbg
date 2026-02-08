// Background daemon: Unix socket server that receives JSON commands from CLI
// and dispatches to CDP command handlers
// Supports multiple concurrent CDP sessions via a session registry

import * as fs from "node:fs";
import * as net from "node:net";
import { CdpClientWrapper } from "./cdp/client.js";
import { discoverTarget } from "./cdp/discovery.js";
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
	DaemonState,
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

	const state = createState();
	const cdp = new CdpClientWrapper(state, store);

	try {
		const discovered = await discoverTarget(port, host);
		await cdp.connect(discovered.wsUrl);
		state.lastWsUrl = discovered.wsUrl;

		const session: Session = {
			name,
			state,
			cdp,
			managedChild: null,
			targetType: discovered.type,
			port,
			host,
		};

		registry.sessions.set(name, session);
		registry.current = name;

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			s: name,
			messages: [`connected to ${host}:${port}`],
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
		await cdp.connect(discovered.wsUrl);
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
		await session.cdp.connect(discovered.wsUrl);
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
			return handleReconnect(session.cdp, session.state, store);
		case "q":
			return handleQuery(cmd.args, session);
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
