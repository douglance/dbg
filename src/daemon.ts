// Background daemon: Unix socket server that receives JSON commands from CLI
// and dispatches to CDP command handlers

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
import type { Command, DaemonState, Response, StoredBreakpoint } from "./protocol.js";
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

let state = createState();
const store = new EventStore();
let cdp = new CdpClientWrapper(state, store);
let managedChild: ChildProcess | null = null;
store.record(
	{
		source: "daemon",
		category: "lifecycle",
		method: "daemon.start",
		data: { pid: process.pid },
	},
	true,
);

// ─── Lifecycle commands ───

async function handleOpen(args: string): Promise<Response> {
	if (state.connected) {
		return { ok: false, error: "already connected; close first" };
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

	try {
		const wsUrl = await discoverTarget(port, host);
		await cdp.connect(wsUrl);
		state.lastWsUrl = wsUrl;
		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			messages: [`connected to ${host}:${port}`],
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function handleClose(): Promise<Response> {
	await cdp.disconnect();
	if (managedChild) {
		killTarget(managedChild);
		managedChild = null;
	}

	const prevPid = state.pid;
	state = createState();
	cdp = new CdpClientWrapper(state, store);

	return {
		ok: true,
		messages: [prevPid ? `closed (pid ${prevPid})` : "closed"],
	};
}

async function handleRun(command: string): Promise<Response> {
	if (state.connected) {
		return { ok: false, error: "already connected; close first" };
	}

	try {
		const { child, port } = await spawnTarget(command);
		managedChild = child;
		state.pid = child.pid ?? null;
		state.managedCommand = command;

		// Listen for process exit
		child.on("exit", () => {
			managedChild = null;
			state.pid = null;
			cdp.disconnect();
		});

		const wsUrl = await discoverTarget(port);
		await cdp.connect(wsUrl);
		state.lastWsUrl = wsUrl;

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			pid: state.pid ?? undefined,
			messages: [`spawned pid=${state.pid}, connected on port ${port}`],
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function handleRestart(): Promise<Response> {
	if (!state.managedCommand) {
		return { ok: false, error: "no managed process to restart" };
	}

	const command = state.managedCommand;
	const savedBreakpoints = Array.from(state.breakpoints.values());

	// Disconnect and kill
	await cdp.disconnect();
	if (managedChild) {
		killTarget(managedChild);
		managedChild = null;
	}

	// Reset state but remember the command
	state = createState();
	state.managedCommand = command;
	cdp = new CdpClientWrapper(state, store);

	// Respawn
	try {
		const { child, port } = await spawnTarget(command);
		managedChild = child;
		state.pid = child.pid ?? null;

		child.on("exit", () => {
			managedChild = null;
			state.pid = null;
			cdp.disconnect();
		});

		const wsUrl = await discoverTarget(port);
		await cdp.connect(wsUrl);
		state.lastWsUrl = wsUrl;

		// Re-apply breakpoints using setBreakpointByUrl so they auto-apply
		// when matching scripts load (we're paused at line 0, scripts not loaded yet)
		const restored: string[] = [];
		for (const bp of savedBreakpoints) {
			try {
				const urlRegex = `.*${bp.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
				const result = (await cdp.send("Debugger.setBreakpointByUrl", {
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
				state.breakpoints.set(result.breakpointId, newBp);
				restored.push(result.breakpointId);
			} catch {
				// Skip breakpoints that can't be restored
			}
		}

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			pid: state.pid ?? undefined,
			messages: [
				`restarted pid=${state.pid}`,
				`restored ${restored.length}/${savedBreakpoints.length} breakpoints`,
			],
		};
	} catch (e) {
		return { ok: false, error: `restart failed: ${(e as Error).message}` };
	}
}

// ─── Dispatch ───

async function dispatch(cmd: Command): Promise<Response> {
	switch (cmd.cmd) {
		case "open":
			return handleOpen(cmd.args);
		case "close":
			return handleClose();
		case "run":
			return handleRun(cmd.args);
		case "restart":
			return handleRestart();
		case "status":
			return handleStatus(cdp, state);
		case "c":
			return handleContinue(cdp, state);
		case "s":
			return handleStepInto(cdp, state);
		case "n":
			return handleStepOver(cdp, state);
		case "o":
			return handleStepOut(cdp, state);
		case "pause":
			return handlePause(cdp, state);
		case "b":
			return handleSetBreakpoint(cdp, state, cmd.args);
		case "db":
			return handleDeleteBreakpoint(cdp, state, cmd.args);
		case "bl":
			return handleListBreakpoints(cdp, state);
		case "e":
			return handleEval(cdp, state, cmd.args);
		case "src":
			return handleSource(cdp, state, cmd.args);
		case "trace":
			return handleTrace(store, cmd.args);
		case "health":
			return handleHealth(cdp, state);
		case "reconnect":
			return handleReconnect(cdp, state, store);
		case "q":
			return handleQuery(cmd.args);
		default:
			return { ok: false, error: `unknown command: ${(cmd as { cmd: string }).cmd}` };
	}
}

async function handleQuery(queryStr: string): Promise<Response> {
	try {
		// Dynamic import — the query engine may not exist yet
		const mod = (await import("./query/engine.js")) as {
			executeQuery: (
				query: string,
				executor: CdpClientWrapper,
			) => Promise<{ columns: string[]; rows: unknown[][] }>;
		};
		const result = await mod.executeQuery(queryStr, cdp);
		return { ok: true, columns: result.columns, rows: result.rows };
	} catch (e) {
		const msg = (e as Error).message;
		if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
			return { ok: false, error: "query engine not available" };
		}
		return { ok: false, error: msg };
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
		if (managedChild) {
			killTarget(managedChild);
		}
		cdp.disconnect();
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
