// CLI <-> Daemon protocol types
// Shared between cli.ts and daemon.ts

export const SOCKET_PATH = "/tmp/dbg.sock";

// ─── CLI → Daemon request ───

export type Command =
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
	| { cmd: "q"; args: string }; // SQL query

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

export interface DaemonState {
	connected: boolean;
	paused: boolean;
	pid: number | null;
	managedCommand: string | null; // non-null if started via `dbg run`

	// CDP state (populated when paused)
	callFrames: CallFrameInfo[];
	asyncStackTrace: AsyncFrameInfo[];

	// Accumulated state
	breakpoints: Map<string, StoredBreakpoint>;
	scripts: Map<string, ScriptInfo>;
	console: ConsoleEntry[];
	exceptions: ExceptionEntry[];
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

// ─── CDP executor interface for query tables ───

export interface CdpExecutor {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	getState(): DaemonState;
}
