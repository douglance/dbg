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
import type {
	AttachPlatform,
	AttachProvider,
	AttachRequest,
	AttachStrategy,
	Command,
	Response,
} from "@dbg/types";
import { SOCKET_PATH } from "@dbg/types";

// ─── Parse argv ───

const SUPPORTED_ATTACH_PROVIDERS: AttachProvider[] = ["apple-device"];
const SUPPORTED_ATTACH_PLATFORMS: AttachPlatform[] = [
	"auto",
	"ios",
	"tvos",
	"watchos",
	"visionos",
];
const SUPPORTED_ATTACH_STRATEGIES: AttachStrategy[] = [
	"auto",
	"device-process",
	"gdb-remote",
];

function parseAttachArgs(tokens: string[]): AttachRequest {
	let provider: AttachProvider = "apple-device";
	let platform: AttachPlatform = "auto";
	let bundleId = "";
	let device: string | undefined;
	let pid: number | undefined;
	let launch = false;
	let attachStrategy: AttachStrategy | undefined;
	let attachTimeoutMs: number | undefined;
	let verbose = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		switch (token) {
			case "--provider": {
				const value = tokens[i + 1];
				if (!value) {
					throw new Error("usage: dbg attach <bundle-id> [--provider <name>]");
				}
				i++;
				if (!SUPPORTED_ATTACH_PROVIDERS.includes(value as AttachProvider)) {
					throw new Error(
						`unsupported provider '${value}'. Supported: ${SUPPORTED_ATTACH_PROVIDERS.join(", ")}`,
					);
				}
				provider = value as AttachProvider;
				break;
			}
			case "--platform": {
				const value = tokens[i + 1];
				if (!value) {
					throw new Error(
						"usage: dbg attach <bundle-id> [--platform <platform>]",
					);
				}
				i++;
				if (!SUPPORTED_ATTACH_PLATFORMS.includes(value as AttachPlatform)) {
					throw new Error(
						`unsupported platform '${value}'. Supported: ${SUPPORTED_ATTACH_PLATFORMS.join(", ")}`,
					);
				}
				platform = value as AttachPlatform;
				break;
			}
			case "--device": {
				const value = tokens[i + 1];
				if (!value) {
					throw new Error("usage: dbg attach <bundle-id> [--device <id>]");
				}
				i++;
				device = value;
				break;
			}
			case "--pid": {
				const value = tokens[i + 1];
				if (!value) {
					throw new Error("usage: dbg attach <bundle-id> [--pid <pid>]");
				}
				i++;
				const parsedPid = Number.parseInt(value, 10);
				if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
					throw new Error("pid must be a positive integer");
				}
				pid = parsedPid;
				break;
			}
			case "--launch":
				launch = true;
				break;
			case "--attach-strategy": {
				const value = tokens[i + 1];
				if (!value) {
					throw new Error(
						"usage: dbg attach <bundle-id> [--attach-strategy auto|device-process|gdb-remote]",
					);
				}
				i++;
				if (!SUPPORTED_ATTACH_STRATEGIES.includes(value as AttachStrategy)) {
					throw new Error(
						`unsupported attach strategy '${value}'. Supported: ${SUPPORTED_ATTACH_STRATEGIES.join(", ")}`,
					);
				}
				attachStrategy = value as AttachStrategy;
				break;
			}
			case "--attach-timeout": {
				const value = tokens[i + 1];
				if (!value) {
					throw new Error(
						"usage: dbg attach <bundle-id> [--attach-timeout <seconds>]",
					);
				}
				i++;
				const parsedSeconds = Number(value);
				if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
					throw new Error(
						"attach-timeout must be a positive number of seconds",
					);
				}
				attachTimeoutMs = Math.round(parsedSeconds * 1000);
				break;
			}
			case "--verbose-attach":
				verbose = true;
				break;
			default:
				if (token.startsWith("--")) {
					throw new Error(`unknown attach flag: ${token}`);
				}
				if (!bundleId) {
					bundleId = token;
				} else {
					throw new Error(`unexpected attach argument: ${token}`);
				}
		}
	}

	if (!bundleId) {
		throw new Error(
			"usage: dbg attach <bundle-id> [--device <id>] [--pid <pid>] [--launch] [--provider apple-device] [--platform auto|ios|tvos|watchos|visionos] [--attach-strategy auto|device-process|gdb-remote] [--attach-timeout <seconds>] [--verbose-attach]",
		);
	}

	const request: AttachRequest = {
		provider,
		platform,
		bundleId,
		protocol: "dap",
	};
	if (device) request.device = device;
	if (pid) request.pid = pid;
	if (launch) request.launch = true;
	if (attachStrategy) request.attachStrategy = attachStrategy;
	if (attachTimeoutMs) request.attachTimeoutMs = attachTimeoutMs;
	if (verbose) request.verbose = true;
	return request;
}

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
		case "devices": {
			// Agent-friendly listing of Apple device + simulator candidates.
			const tokens = cmdArgs.slice(1);
			let platform: AttachPlatform | undefined;
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				switch (token) {
					case "--platform": {
						const value = tokens[i + 1];
						if (!value) {
							error(
								"usage: dbg devices [--platform auto|ios|tvos|watchos|visionos]",
							);
							return null;
						}
						i++;
						if (!SUPPORTED_ATTACH_PLATFORMS.includes(value as AttachPlatform)) {
							error(
								`unsupported platform '${value}'. Supported: ${SUPPORTED_ATTACH_PLATFORMS.join(", ")}`,
							);
							return null;
						}
						platform = value as AttachPlatform;
						break;
					}
					default:
						if (token.trim() === "") continue;
						error(`unknown devices flag: ${token}`);
						return null;
				}
			}

			const payload: Record<string, unknown> = {};
			if (platform) payload.platform = platform;
			const args = Object.keys(payload).length
				? JSON.stringify(payload)
				: undefined;
			return { cmd: withSession({ cmd: "devices", args }), jsonMode };
		}

		case "open": {
			if (!rest) {
				error(
					"usage: dbg open <port|host:port> [--type page|node] [--target <id>]",
				);
				return null;
			}
			// Extract positional args (port and optional session name) from
			// the tokens, skipping flags and their values.
			const openParts = cmdArgs.slice(1);
			const positional: string[] = [];
			const flagTokens: string[] = [];
			for (let i = 0; i < openParts.length; i++) {
				if (openParts[i] === "--type" || openParts[i] === "--target") {
					flagTokens.push(openParts[i]);
					if (i + 1 < openParts.length) {
						flagTokens.push(openParts[i + 1]);
						i++;
					}
				} else {
					positional.push(openParts[i]);
				}
			}
			// positional[0] = port/host:port, positional[1] = optional session name
			const portArg = positional[0];
			const openSessionName = positional[1] || sessionName;
			// Build args for daemon: port + flags (no session name)
			const daemonArgs = [portArg, ...flagTokens].join(" ");
			const cmd: Command = { cmd: "open", args: daemonArgs };
			if (openSessionName) cmd.s = openSessionName;
			return { cmd, jsonMode };
		}

		case "attach": {
			let request: AttachRequest;
			try {
				request = parseAttachArgs(cmdArgs.slice(1));
			} catch (err) {
				error((err as Error).message);
				return null;
			}
			return {
				cmd: withSession({ cmd: "attach", args: JSON.stringify(request) }),
				jsonMode,
			};
		}

		case "attach-lldb": {
			if (!rest) {
				error("usage: dbg attach-lldb <program-path> [args...]");
				return null;
			}
			return {
				cmd: withSession({ cmd: "attach-lldb", args: rest }),
				jsonMode,
			};
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

		case "navigate": {
			if (!rest) {
				error("usage: dbg navigate <url|reload|back|forward>");
				return null;
			}
			return { cmd: withSession({ cmd: "navigate", args: rest }), jsonMode };
		}

		case "screenshot": {
			return {
				cmd: withSession({ cmd: "screenshot", args: queryArgs || undefined }),
				jsonMode,
			};
		}

		case "click": {
			if (!rest) {
				error('usage: dbg click "<selector>"');
				return null;
			}
			return { cmd: withSession({ cmd: "click", args: rest }), jsonMode };
		}

		case "type": {
			if (!rest) {
				error('usage: dbg type "<selector>" "<text>"');
				return null;
			}
			return { cmd: withSession({ cmd: "type", args: rest }), jsonMode };
		}

		case "select": {
			if (!rest) {
				error('usage: dbg select "<selector>" "<value>"');
				return null;
			}
			return { cmd: withSession({ cmd: "select", args: rest }), jsonMode };
		}

		case "mock": {
			if (!rest) {
				error("usage: dbg mock <url-pattern> <json-body> [--status <code>]");
				return null;
			}
			return { cmd: withSession({ cmd: "mock", args: rest }), jsonMode };
		}

		case "unmock": {
			return {
				cmd: withSession({ cmd: "unmock", args: rest || undefined }),
				jsonMode,
			};
		}

		case "emulate": {
			if (!rest) {
				error("usage: dbg emulate <device|reset>");
				return null;
			}
			return {
				cmd: withSession({ cmd: "emulate", args: rest }),
				jsonMode,
			};
		}

		case "throttle": {
			if (!rest) {
				error("usage: dbg throttle <preset|off>");
				return null;
			}
			return {
				cmd: withSession({ cmd: "throttle", args: rest }),
				jsonMode,
			};
		}

		case "coverage": {
			if (!rest) {
				error("usage: dbg coverage start|stop");
				return null;
			}
			return {
				cmd: withSession({ cmd: "coverage", args: rest }),
				jsonMode,
			};
		}

		case "registers":
			return { cmd: withSession({ cmd: "registers" }), jsonMode };

		case "memory": {
			if (!rest) {
				error("usage: dbg memory <address> <length>");
				return null;
			}
			return { cmd: withSession({ cmd: "memory", args: rest }), jsonMode };
		}

		case "disasm":
			return {
				cmd: withSession({ cmd: "disasm", args: rest || undefined }),
				jsonMode,
			};

		case "targets": {
			if (!rest) {
				error("usage: dbg targets <port|host:port>");
				return null;
			}
			return { cmd: { cmd: "targets", args: rest }, jsonMode };
		}

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
  attach <bundle-id>       Attach to app on device via provider (DAP)
                           Flags: --device --pid --launch --attach-strategy --attach-timeout --verbose-attach
  devices                  List Apple devices + simulators (TSV)
  attach-lldb <program>    Launch lldb-dap for local native binary
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
  trace [limit]            Show recent protocol messages
  health                   Verify debugger connection health
  reconnect                Reconnect to last websocket target
  navigate <url|reload|back>  Navigate browser page
  screenshot [file]           Capture page screenshot
  click "<selector>"         Click element
  type "<selector>" "<text>" Type into element
  select "<selector>" "<val>" Select dropdown option
  mock <pattern> <body>      Mock network response
  unmock [pattern]            Remove mock(s)
  emulate <device|reset>     Emulate mobile device
  throttle <preset|off>      Throttle network
  coverage start|stop        Track code coverage
  registers                Show register values (LLDB sessions)
  memory <addr> <len>      Read process memory (LLDB sessions)
  disasm [addr]            Show disassembly around address/current frame
  targets <port>             List debuggable targets
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
  dbg attach com.workstation.app --provider apple-device --platform auto
                                     Attach to running app on Apple device/simulator.
  dbg attach com.workstation.app --attach-strategy auto --attach-timeout 45
                                     Attach with strategy fallback + timeout override.
  dbg devices                         List available Apple device/simulator targets.
  dbg attach-lldb ./a.out            Launch LLDB DAP for local binary.
  dbg open 9229                     Local port (auto-named session).
  dbg open 9229 be                  Named session "be".
  dbg open 192.168.1.5:9229 remote  Remote host, named "remote".
  dbg attach <bundle-id>            Generic attach command.
  dbg attach com.workstation.app --device <id|sim:name|device:udid> [--pid <pid>] [--verbose-attach]
                                    Attach by provider-resolved PID on device or simulator.
  dbg open 9222 --type page            Explicitly target browser page.
  dbg open 9222 --target <id>          Connect to specific tab by ID.
  dbg targets 9222                     List all debuggable targets.
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
  dbg trace [limit]              Show recent protocol send/recv history.
  dbg health                     Probe Runtime.evaluate("1+1"), report latency.
  dbg reconnect                  Reconnect to the last known websocket URL.

BROWSER
  dbg navigate <url>           Navigate to URL.
  dbg navigate reload          Reload current page.
  dbg navigate back            Go back in history.
  dbg navigate forward         Go forward in history.
  dbg screenshot               Capture screenshot (returns base64 PNG).
  dbg screenshot /tmp/page.png Save screenshot to file.
  dbg click "button.submit"                 Click element by CSS selector.
  dbg type "input#email" "user@test.com"    Type text into an element.
  dbg select "select#country" "US"          Select dropdown option.

NETWORK MOCKING
  dbg mock "/api/users" '{"users":[]}'     Intercept URL, return mock JSON.
  dbg mock "/api/data" '{}' --status 500    Return specific HTTP status.
  dbg unmock "/api/users"                   Remove specific mock.
  dbg unmock                                Remove all mocks.

EMULATION
  dbg emulate iphone-14    Emulate iPhone 14 (390x844).
  dbg emulate ipad         Emulate iPad (810x1080).
  dbg emulate pixel-7      Emulate Pixel 7 (412x915).
  dbg emulate reset        Reset to default viewport.

  dbg throttle 3g          Simulate 3G network.
  dbg throttle slow-3g     Simulate slow 3G.
  dbg throttle fast-3g     Simulate fast 3G.
  dbg throttle 4g          Simulate 4G.
  dbg throttle offline     Simulate offline.
  dbg throttle off         Disable throttling.

COVERAGE
  dbg coverage start       Begin tracking JS + CSS usage.
  dbg coverage stop        Stop tracking.
  dbg q "SELECT * FROM coverage"   View coverage results.

NATIVE (LLDB / DAP)
  dbg registers            Show CPU registers.
  dbg memory <addr> <len>  Read memory bytes.
  dbg disasm [addr]        Disassemble around address/current location.

QUERY ENGINE (SQL-like)
  dbg q "<query>"                Run a SQL-like query against virtual tables.
  dbg q "SELECT * FROM frames"   Stack frames.
  dbg q "SELECT name, value FROM vars WHERE frame_id = 0"
  dbg q "SELECT ts, stream, severity, summary FROM timeline ORDER BY ts DESC LIMIT 120"

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
	    timeline        Unified issue timeline (id, ts, stream, method, severity, summary, ...)
	    network         HTTP requests (id, method, url, status, type, duration_ms, size)
    network_headers Request/response headers (requires WHERE request_id=)
    network_body    Response body (requires WHERE request_id=)
    page_events     Page lifecycle events (id, name, ts, frame_id, url)
    dom             DOM elements (requires WHERE selector='<css>')
    styles          Computed CSS (requires WHERE node_id=<id>)
    performance     Runtime metrics (name, value)
    cookies         Browser cookies (name, value, domain, path, ...)
    storage         Web storage (requires WHERE type='local'|'session')
    ws_frames       WebSocket frames (id, request_id, data, ts, direction)
    coverage        Code coverage (url, total_bytes, used_bytes, used_pct)

  Drill-down pattern:
    dbg q "SELECT name, object_id FROM vars WHERE name = 'config'"
    dbg q "SELECT name, value FROM props WHERE object_id = '<id>'"

  Postmortem mode (no active session required for event-backed tables):
    dbg q "SELECT method FROM events ORDER BY id DESC LIMIT 20"
    dbg q "SELECT ts, stream, severity, method, summary FROM timeline WHERE include = 'errors' ORDER BY ts DESC LIMIT 80"

OUTPUT
  All data goes to stdout. Errors go to stderr.
  TSV format by default. Append \\j to any query for JSON output:
    dbg q "SELECT * FROM frames\\j"
  Exit code 0 on success, 1 on error.

ENVIRONMENT
  DBG_SOCK          Socket path for daemon (default: /tmp/dbg.sock)
  DBG_EVENTS_DB     Event store path (default: /tmp/dbg-events.db)
                    Set to a persistent path to accumulate history across runs.

SELF-DEBUGGING
  To debug dbg's own daemon, run a second instance on a different socket:
    DBG_SOCK=/tmp/dbg2.sock DBG_EVENTS_DB=/tmp/dbg2-events.db \\
      node --inspect-brk=9230 dist/daemon.js
    dbg open 9230`;
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
		env: process.env,
	});
	child.unref();
	child.disconnect?.();

	// Poll for socket to appear (daemon creates it on startup)
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		if (await isDaemonRunning()) return;
	}
	throw new Error("daemon failed to start (socket not created)");
}

// ─── Socket communication ───

function sendCommand(cmd: Command, timeoutMs: number): Promise<Response> {
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
				new Error(`cannot connect to daemon at ${SOCKET_PATH}: ${err.message}`),
			);
		});

		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			reject(
				new Error(
					`timeout waiting for daemon response (${Math.ceil(timeoutMs / 1000)}s)`,
				),
			);
		});
	});
}

function computeCommandTimeoutMs(cmd: Command): number {
	const DEFAULT_TIMEOUT_MS = 60000;

	if (cmd.cmd === "attach") {
		const DEFAULT_ATTACH_TIMEOUT_MS = 45000;
		try {
			const request = JSON.parse(cmd.args) as {
				attachTimeoutMs?: unknown;
				attachStrategy?: unknown;
			};
			const base =
				typeof request.attachTimeoutMs === "number" &&
				Number.isFinite(request.attachTimeoutMs) &&
				request.attachTimeoutMs > 0
					? Math.round(request.attachTimeoutMs)
					: DEFAULT_ATTACH_TIMEOUT_MS;
			const strategy =
				typeof request.attachStrategy === "string"
					? request.attachStrategy
					: "auto";
			const attempts = strategy === "auto" ? 2 : 1;
			return Math.max(DEFAULT_TIMEOUT_MS, base * attempts + 30000);
		} catch {
			return DEFAULT_TIMEOUT_MS;
		}
	}

	return DEFAULT_TIMEOUT_MS;
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
			r.phase,
			r.lastErrorCode,
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

	// Screenshot (no file path — print summary, data is in response JSON)
	if (cmd.cmd === "screenshot" && r.data) {
		if (jsonMode) {
			return JSON.stringify({ data: r.data });
		}
		return `[base64 PNG: ${r.data.length} chars] (use \\j for data)`;
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

	// `close` should be idempotent and not auto-start the daemon.
	if (cmd.cmd === "close" && !fs.existsSync(SOCKET_PATH)) {
		process.exit(0);
	}

	try {
		const response = await sendCommand(cmd, computeCommandTimeoutMs(cmd));

		if (!response.ok) {
			error(response.error);
			process.exit(1);
		}

		const output = formatResponse(cmd, response, jsonMode);
		if (output) {
			process.stdout.write(`${output}\n`);
		}
	} catch (e) {
		if (cmd.cmd === "close") {
			// If the daemon isn't running (or the socket is stale), treat close as a no-op.
			try {
				fs.unlinkSync(SOCKET_PATH);
			} catch {
				// ignore
			}
			process.exit(0);
		}
		error((e as Error).message);
		process.exit(1);
	}
}

function error(msg: string): void {
	process.stderr.write(`error: ${msg}\n`);
}

main();
