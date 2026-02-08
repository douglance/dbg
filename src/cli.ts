// Thin CLI client: parses argv, connects to daemon socket, formats output

import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatBreakpointList,
	formatBreakpointSet,
	formatFlowStatus,
	formatJson,
	formatSource,
	formatStatus,
	formatTsv,
} from "./format.js";
import type { Command, Response } from "./protocol.js";
import { SOCKET_PATH } from "./protocol.js";

// ─── Parse argv ───

function parseArgs(argv: string[]): { cmd: Command; jsonMode: boolean } | null {
	// argv[0] = node, argv[1] = script
	const args = argv.slice(2);
	if (args.length === 0) {
		printUsage();
		return null;
	}

	// Extract @name prefix for session targeting: dbg @be c
	let sessionName: string | undefined;
	let cmdArgs = args;
	if (args[0].startsWith("@")) {
		sessionName = args[0].slice(1);
		cmdArgs = args.slice(1);
		if (cmdArgs.length === 0) {
			error("missing command after @session");
			return null;
		}
	}

	const command = cmdArgs[0];

	if (command === "--help" || command === "-h" || command === "help") {
		printHelp();
		return null;
	}

	const rest = cmdArgs.slice(1).join(" ");
	let jsonMode = false;

	// Check for \j suffix on query args
	let queryArgs = rest;
	if (queryArgs.endsWith("\\j")) {
		jsonMode = true;
		queryArgs = queryArgs.slice(0, -2).trimEnd();
	}

	// Helper to attach session name
	function withSession<T extends Command>(cmd: T): T {
		if (sessionName) cmd.s = sessionName;
		return cmd;
	}

	switch (command) {
		case "open": {
			if (!rest) {
				error("usage: dbg open <port|host:port> [session-name]");
				return null;
			}
			// Split: first token is port/host:port, second is optional session name
			const openParts = cmdArgs.slice(1);
			const portArg = openParts[0];
			const openSessionName = openParts[1] || sessionName;
			const cmd: Command = { cmd: "open", args: portArg };
			if (openSessionName) cmd.s = openSessionName;
			return { cmd, jsonMode };
		}

		case "close":
			return { cmd: withSession({ cmd: "close" }), jsonMode };

		case "run":
			if (!rest) {
				error("usage: dbg run <command>");
				return null;
			}
			return { cmd: withSession({ cmd: "run", args: rest }), jsonMode };

		case "restart":
			return { cmd: withSession({ cmd: "restart" }), jsonMode };

		case "status":
			return { cmd: withSession({ cmd: "status" }), jsonMode };

		case "c":
			return { cmd: withSession({ cmd: "c" }), jsonMode };

		case "s":
			return { cmd: withSession({ cmd: "s" }), jsonMode };

		case "n":
			return { cmd: withSession({ cmd: "n" }), jsonMode };

		case "o":
			return { cmd: withSession({ cmd: "o" }), jsonMode };

		case "pause":
			return { cmd: withSession({ cmd: "pause" }), jsonMode };

		case "b":
			if (!rest) {
				error("usage: dbg b <file:line> [if <condition>]");
				return null;
			}
			return { cmd: withSession({ cmd: "b", args: rest }), jsonMode };

		case "db":
			if (!rest) {
				error("usage: dbg db <breakpoint-id>");
				return null;
			}
			return { cmd: withSession({ cmd: "db", args: rest }), jsonMode };

		case "bl":
			return { cmd: withSession({ cmd: "bl" }), jsonMode };

		case "e":
			if (!rest) {
				error("usage: dbg e <expression>");
				return null;
			}
			return { cmd: withSession({ cmd: "e", args: rest }), jsonMode };

		case "src":
			return {
				cmd: withSession({ cmd: "src", args: rest || undefined }),
				jsonMode,
			};

		case "trace":
			return {
				cmd: withSession({ cmd: "trace", args: queryArgs || undefined }),
				jsonMode,
			};

		case "health":
			return { cmd: withSession({ cmd: "health" }), jsonMode };

		case "reconnect":
			return { cmd: withSession({ cmd: "reconnect" }), jsonMode };

		case "q":
			if (!queryArgs) {
				error("usage: dbg q <query>");
				return null;
			}
			return { cmd: withSession({ cmd: "q", args: queryArgs }), jsonMode };

		case "ss":
			return { cmd: { cmd: "ss" }, jsonMode };

		case "use":
			if (!rest) {
				error("usage: dbg use <session-name>");
				return null;
			}
			return { cmd: { cmd: "use", args: rest }, jsonMode };

		default:
			error(`unknown command: ${command}`);
			printUsage();
			return null;
	}
}

function printUsage(): void {
	const usage = `usage: dbg [<@session>] <command> [args]
       dbg --help

commands:
  open <port> [name]       Connect to debug port (optional session name)
  close                    Disconnect session
  run <command>            Spawn process with --inspect-brk and connect
  restart                  Restart managed process
  status                   Show connection and pause status
  ss                       List all sessions
  use <name>               Switch current session
  c                        Continue execution
  s                        Step into
  n                        Step over
  o                        Step out
  pause                    Pause execution
  b <file:line> [if cond]  Set breakpoint
  db <id>                  Delete breakpoint
  bl                       List breakpoints
  e <expression>           Evaluate expression
  src [file start end]     View source
  trace [limit]            Show recent CDP messages
  health                   Verify debugger connection health
  reconnect                Reconnect to last websocket target
  q <query>                Run SQL query

Session targeting: @name prefix targets a session (e.g., dbg @be c)

Run 'dbg --help' for detailed usage and examples.`;
	process.stderr.write(`${usage}\n`);
}

function printHelp(): void {
	const help = `dbg - Stateless CLI debugger for AI agents

Every invocation is one command in, one response out, exit.
A background daemon holds CDP connections between calls.

LIFECYCLE
  dbg open <port|host:port> [name]  Attach to a running debug target.
  dbg open 9229                     Local port (auto-named session).
  dbg open 9229 be                  Named session "be".
  dbg open 192.168.1.5:9229 remote  Remote host, named "remote".
  dbg close                         Disconnect session. If started via 'run',
                                    also kills the target process.
  dbg run "<command>"               Spawn with --inspect-brk, connect.
  dbg run "node server.ts"          Example.
  dbg restart                       Kill managed target, respawn same command,
                                    reconnect, re-apply all breakpoints.
  dbg status                        Show connection state, pause state, location.

SESSIONS
  dbg ss                            List all active sessions.
  dbg use <name>                    Switch current session.
  dbg @name <command>               Target a specific session.
  dbg @be c                         Continue execution on "be" session.
  dbg @fe status                    Check status of "fe" session.

  Single session: no @name needed (backwards compatible).
  Multiple sessions: use @name or 'use' to target.

FLOW CONTROL
  dbg c                          Continue. Blocks until next pause or returns
                                 'running' if no breakpoint is hit.
  dbg s                          Step into. Blocks until paused.
  dbg n                          Step over. Blocks until paused.
  dbg o                          Step out. Blocks until paused.
  dbg pause                      Pause execution.

  Output: paused<TAB>file<TAB>line<TAB>function
     or: running

BREAKPOINTS
  dbg b <file:line>              Set breakpoint.
  dbg b app.ts:42                Example.
  dbg b app.ts:42 if x>0         Conditional breakpoint.
  dbg db <id>                    Delete breakpoint by ID.
  dbg bl                         List all breakpoints (TSV).

INSPECTION
  dbg e "<expression>"           Evaluate expression in current frame.
  dbg e "process.pid"            Example. Output: bare value, one line.
  dbg src                        View source around current paused location.
  dbg src <file> <start> <end>   View specific line range.
  dbg trace [limit]              Show recent CDP send/recv history.
  dbg health                     Probe Runtime.evaluate("1+1"), report latency.
  dbg reconnect                  Reconnect to the last known websocket URL.

QUERY ENGINE (SQL-like)
  dbg q "<query>"                Run a SQL-like query against virtual tables.
  dbg q "SELECT * FROM frames"   Stack frames.
  dbg q "SELECT name, value FROM vars WHERE frame_id = 0"

  Syntax:
    SELECT [cols | *] FROM <table>
      [WHERE <conditions>]
      [ORDER BY <col> [ASC|DESC]]
      [LIMIT <n>]

  WHERE operators: =, !=, <, >, <=, >=, LIKE, AND, OR, ()

  Virtual tables:
    frames          Stack frames (id, function, file, line, col, url, script_id)
    scopes          Scope chains (id, frame_id, type, name, object_id)
    vars            Variables (frame_id, scope, name, type, value, object_id)
                    Defaults to frame 0, skips global scope.
    this            'this' binding per frame (frame_id, type, value, object_id)
    props           Object properties (requires WHERE object_id=)
    proto           Prototype chain (requires WHERE object_id=)
    breakpoints     All breakpoints (id, file, line, condition, hits, enabled)
    scripts         Loaded scripts (id, file, url, lines, source_map, is_module)
    source          Source lines (requires WHERE file= or script_id=)
    console         Console messages (id, type, text, ts, stack)
    exceptions      Thrown exceptions (id, text, type, file, line, ts, uncaught)
    async_frames    Async stack traces (id, function, file, line, parent_id)
    listeners       Event listeners (requires WHERE object_id=)
    events          Raw daemon/CDP event log (id, ts, source, category, method, data, session_id)
    cdp             CDP-focused event view (id, ts, direction, method, latency_ms, error, data)
    cdp_messages    Alias of cdp
    connections     Connection lifecycle events (id, ts, event, session_id, data)

  Drill-down pattern:
    dbg q "SELECT name, object_id FROM vars WHERE name = 'config'"
    dbg q "SELECT name, value FROM props WHERE object_id = '<id>'"

OUTPUT
  All data goes to stdout. Errors go to stderr.
  TSV format by default. Append \\j to any query for JSON output:
    dbg q "SELECT * FROM frames\\j"
  Exit code 0 on success, 1 on error.`;
	process.stdout.write(`${help}\n`);
}

// ─── Daemon management ───

function isDaemonRunning(): Promise<boolean> {
	return new Promise((resolve) => {
		if (!fs.existsSync(SOCKET_PATH)) {
			resolve(false);
			return;
		}
		const socket = net.createConnection(SOCKET_PATH);
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			resolve(false);
		});
		socket.setTimeout(1000, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function ensureDaemon(): Promise<void> {
	if (await isDaemonRunning()) return;

	// Clean up stale socket file
	try {
		fs.unlinkSync(SOCKET_PATH);
	} catch {
		// doesn't exist
	}

	const thisFile = fileURLToPath(import.meta.url);
	const thisDir = dirname(thisFile);
	const daemonPath = join(thisDir, "daemon.js");

	// Spawn daemon fully detached — no pipes, no IPC
	const child = fork(daemonPath, [], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	child.disconnect?.();

	// Poll for socket to appear (daemon creates it on startup)
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		if (fs.existsSync(SOCKET_PATH)) {
			// Verify we can connect
			if (await isDaemonRunning()) return;
		}
	}
	throw new Error("daemon failed to start (socket not created)");
}

// ─── Socket communication ───

function sendCommand(cmd: Command): Promise<Response> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(SOCKET_PATH);
		let buffer = "";

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(cmd)}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newlineIdx = buffer.indexOf("\n");
			if (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				try {
					const response = JSON.parse(line) as Response;
					socket.destroy();
					resolve(response);
				} catch {
					socket.destroy();
					reject(new Error("invalid response from daemon"));
				}
			}
		});

		socket.on("error", (err) => {
			reject(
				new Error(`cannot connect to daemon: ${err.message}. Is it running?`),
			);
		});

		socket.setTimeout(60000, () => {
			socket.destroy();
			reject(new Error("timeout waiting for daemon response"));
		});
	});
}

// ─── Output formatting ───

function formatResponse(
	cmd: Command,
	response: Response,
	jsonMode: boolean,
): string {
	if (!response.ok) return "";

	const r = response;

	// Query results (tabular data)
	if (r.columns && r.rows) {
		return jsonMode
			? formatJson(r.columns, r.rows)
			: formatTsv(r.columns, r.rows);
	}

	// Flow commands (c, s, n, o, pause)
	if (r.status && ["c", "s", "n", "o", "pause"].includes(cmd.cmd)) {
		return formatFlowStatus(r.status, r.file, r.line, r.function);
	}

	// Status command
	if (cmd.cmd === "status") {
		return formatStatus(
			r.connected ?? false,
			r.status === "paused",
			r.file,
			r.line,
			r.function,
			r.pid,
			r.s,
		);
	}

	// Breakpoint set
	if (cmd.cmd === "b" && r.id && r.file !== undefined && r.line !== undefined) {
		return formatBreakpointSet(r.id, r.file, r.line);
	}

	// Breakpoint list (handled above via columns/rows)

	// Eval result — bare value, single line
	if (cmd.cmd === "e" && r.value !== undefined) {
		return r.value;
	}

	// Source view
	if (cmd.cmd === "src" && r.value !== undefined) {
		return r.value;
	}

	// Messages (run, restart, close, open)
	if (r.messages) {
		return r.messages.join("\n");
	}

	return "";
}

// ─── Main ───

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	if (rawArgs.length === 0) {
		printUsage();
		process.exit(1);
	}
	if (rawArgs[0] === "--help" || rawArgs[0] === "-h" || rawArgs[0] === "help") {
		printHelp();
		process.exit(0);
	}

	const parsed = parseArgs(process.argv);
	if (!parsed) {
		process.exit(1);
	}

	const { cmd, jsonMode } = parsed;

	// Auto-start daemon for commands that need it
	const needsDaemon = cmd.cmd !== "close";
	if (needsDaemon) {
		try {
			await ensureDaemon();
		} catch (e) {
			error((e as Error).message);
			process.exit(1);
		}
	}

	try {
		const response = await sendCommand(cmd);

		if (!response.ok) {
			error(response.error);
			process.exit(1);
		}

		const output = formatResponse(cmd, response, jsonMode);
		if (output) {
			process.stdout.write(`${output}\n`);
		}
	} catch (e) {
		error((e as Error).message);
		process.exit(1);
	}
}

function error(msg: string): void {
	process.stderr.write(`error: ${msg}\n`);
}

main();
