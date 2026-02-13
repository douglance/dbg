import type { EventStore } from "./store.js";

// CLI <-> Daemon protocol types
// Shared between cli.ts and daemon.ts

export const SOCKET_PATH = process.env.DBG_SOCK ?? "/tmp/dbg.sock";

// ─── CLI → Daemon request ───

// All commands carry an optional session name `s` for multi-session targeting.
// Wire format: {"cmd":"c","s":"be"}
export type Command = { s?: string } & (
	| { cmd: "open"; args: string } // port or host:port
	| { cmd: "close" }
	| { cmd: "run"; args: string } // shell command to spawn
	| { cmd: "restart" }
	| { cmd: "status" }
	| { cmd: "c" } // continue
	| { cmd: "s" } // step into
	| { cmd: "n" } // step over
	| { cmd: "o" } // step out
	| { cmd: "pause" }
	| { cmd: "b"; args: string } // file:line [if condition]
	| { cmd: "db"; args: string } // breakpoint id
	| { cmd: "bl" } // list breakpoints
	| { cmd: "e"; args: string } // expression
	| { cmd: "src"; args?: string } // optional "file line_start line_end"
	| { cmd: "trace"; args?: string }
	| { cmd: "health" }
	| { cmd: "reconnect" }
	| { cmd: "q"; args: string } // SQL query
	| { cmd: "ss" } // list sessions
	| { cmd: "use"; args: string } // switch current session
	| { cmd: "navigate"; args: string } // url, "reload", "back", or "forward"
	| { cmd: "screenshot"; args?: string } // optional file path
	| { cmd: "click"; args: string } // CSS selector
	| { cmd: "type"; args: string } // "selector" "text"
	| { cmd: "select"; args: string } // "selector" "value"
	| { cmd: "mock"; args: string } // url-pattern json-body [--status code]
	| { cmd: "unmock"; args?: string } // optional url-pattern
	| { cmd: "emulate"; args: string } // preset name or "reset"
	| { cmd: "throttle"; args: string } // preset name or "off"
	| { cmd: "coverage"; args: string } // "start" or "stop"
	| { cmd: "targets"; args: string } // port or host:port
);

// ─── Daemon → CLI response ───

export interface OkResponse {
	ok: true;
	// Flow commands
	status?: "paused" | "running";
	file?: string;
	line?: number;
	function?: string;
	// Query / breakpoint list
	columns?: string[];
	rows?: unknown[][];
	// Eval
	value?: string;
	type?: string;
	// Breakpoint set
	id?: string;
	// Status command
	connected?: boolean;
	pid?: number;
	// Run/restart
	messages?: string[];
	latencyMs?: number;
	// Screenshot
	data?: string; // base64 data
	// Session info
	s?: string; // session name in response
	sessions?: SessionInfo[];
}

export interface ErrResponse {
	ok: false;
	error: string;
}

export type Response = OkResponse | ErrResponse;

// ─── Daemon internal state ───

export interface StoredBreakpoint {
	id: string; // scriptId:lineNumber:columnNumber from CDP
	file: string;
	line: number;
	condition: string;
	hits: number;
	enabled: boolean;
	cdpBreakpointId: string; // CDP's breakpoint ID for removal
}

export interface ScriptInfo {
	id: string; // CDP script ID
	file: string; // extracted filename
	url: string;
	lines: number;
	sourceMap: string;
	isModule: boolean;
}

export interface ConsoleEntry {
	id: number;
	type: string;
	text: string;
	ts: number;
	stack: string;
}

export interface ExceptionEntry {
	id: number;
	text: string;
	type: string;
	file: string;
	line: number;
	ts: number;
	uncaught: boolean;
}

export interface NetworkRequest {
	id: string;
	url: string;
	method: string;
	status: number;
	type: string;
	mimeType: string;
	startTime: number;
	endTime: number;
	duration: number;
	size: number;
	error: string;
	requestHeaders: string; // JSON string
	responseHeaders: string; // JSON string
	initiator: string;
}

export interface PageEvent {
	id: number;
	name: string;
	ts: number;
	frameId: string;
	url: string;
}

export interface WebSocketFrame {
	id: number;
	requestId: string;
	opcode: number;
	data: string;
	ts: number;
	direction: "sent" | "received";
}

export interface JsCoverageRange {
	startOffset: number;
	endOffset: number;
	count: number;
}

export interface JsCoverageScript {
	url: string;
	functions: Array<{
		ranges: JsCoverageRange[];
	}>;
}

export interface CssCoverageEntry {
	styleSheetId: string;
	startOffset: number;
	endOffset: number;
	used: boolean;
}

export interface CoverageSnapshot {
	js: JsCoverageScript[];
	css: CssCoverageEntry[];
	capturedAt: number;
}

export interface DaemonState {
	connected: boolean;
	paused: boolean;
	pid: number | null;
	managedCommand: string | null; // non-null if started via `dbg run`
	lastWsUrl: string | null;

	// CDP state (populated when paused)
	callFrames: CallFrameInfo[];
	asyncStackTrace: AsyncFrameInfo[];

	// Accumulated state
	breakpoints: Map<string, StoredBreakpoint>;
	scripts: Map<string, ScriptInfo>;
	console: ConsoleEntry[];
	exceptions: ExceptionEntry[];

	// Browser state (page targets only)
	networkRequests: Map<string, NetworkRequest>;
	pageEvents: PageEvent[];
	wsFrames: WebSocketFrame[];

	// Coverage snapshots persisted at "coverage stop"
	coverageSnapshot: CoverageSnapshot | null;
}

export interface CallFrameInfo {
	callFrameId: string;
	functionName: string;
	url: string;
	file: string;
	line: number;
	col: number;
	scriptId: string;
	scopeChain: ScopeInfo[];
	thisObjectId: string;
}

export interface ScopeInfo {
	type: string;
	name: string;
	objectId: string;
}

export interface AsyncFrameInfo {
	id: number;
	functionName: string;
	file: string;
	line: number;
	parentId: number | null;
	description: string;
}

// ─── Multi-session types ───

export interface Session {
	name: string;
	state: DaemonState;
	cdp: import("./cdp/client.js").CdpClientWrapper;
	managedChild: import("node:child_process").ChildProcess | null;
	targetType: "node" | "page";
	port: number;
	host: string;
	targetUrl?: string;
	targetTitle?: string;
}

export interface SessionInfo {
	name: string;
	connected: boolean;
	paused: boolean;
	targetType: "node" | "page";
	port: number;
	host: string;
	pid: number | null;
	current: boolean;
	targetUrl?: string;
	targetTitle?: string;
}

// ─── CDP executor interface for query tables ───

export interface CdpExecutor {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	getState(): DaemonState;
	getStore?(): EventStore | null;
}
