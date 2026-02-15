export declare const SOCKET_PATH: string;
export type SessionProtocol = "cdp" | "dap";
export type DapSessionPhase =
	| "starting"
	| "configuring"
	| "paused"
	| "running"
	| "terminated"
	| "error";
export interface SessionCapabilities {
	breakpoints: boolean;
	stepping: boolean;
	evaluation: boolean;
	stackFrames: boolean;
	variables: boolean;
	sourceView: boolean;
	dom: boolean;
	css: boolean;
	network: boolean;
	page: boolean;
	storage: boolean;
	emulation: boolean;
	coverage: boolean;
	registers: boolean;
	memory: boolean;
	disassembly: boolean;
	watchpoints: boolean;
}
export interface EventStoreLike {
	query(sql: string, params?: unknown[]): Record<string, unknown>[];
	record?: (
		event: {
			ts?: number;
			source: string;
			category: string;
			method: string;
			data?: unknown;
			sessionId?: string | null;
		},
		flushNow?: boolean,
	) => void;
}
export interface DebugExecutor {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	getState(): DebuggerState;
	getStore?(): EventStoreLike | null;
	readonly protocol: SessionProtocol;
	readonly capabilities: SessionCapabilities;
}
export type CdpExecutor = DebugExecutor;
export type Command = {
	s?: string;
} & (
	| {
			cmd: "open";
			args: string;
	  }
	| {
			cmd: "attach";
			args: string;
	  }
	| {
			cmd: "attach-lldb";
			args: string;
	  }
	| {
			cmd: "close";
	  }
	| {
			cmd: "run";
			args: string;
	  }
	| {
			cmd: "restart";
	  }
	| {
			cmd: "status";
	  }
	| {
			cmd: "c";
	  }
	| {
			cmd: "s";
	  }
	| {
			cmd: "n";
	  }
	| {
			cmd: "o";
	  }
	| {
			cmd: "pause";
	  }
	| {
			cmd: "b";
			args: string;
	  }
	| {
			cmd: "db";
			args: string;
	  }
	| {
			cmd: "bl";
	  }
	| {
			cmd: "e";
			args: string;
	  }
	| {
			cmd: "src";
			args?: string;
	  }
	| {
			cmd: "trace";
			args?: string;
	  }
	| {
			cmd: "health";
	  }
	| {
			cmd: "reconnect";
	  }
	| {
			cmd: "q";
			args: string;
	  }
	| {
			cmd: "ss";
	  }
	| {
			cmd: "use";
			args: string;
	  }
	| {
			cmd: "navigate";
			args: string;
	  }
	| {
			cmd: "screenshot";
			args?: string;
	  }
	| {
			cmd: "click";
			args: string;
	  }
	| {
			cmd: "type";
			args: string;
	  }
	| {
			cmd: "select";
			args: string;
	  }
	| {
			cmd: "mock";
			args: string;
	  }
	| {
			cmd: "unmock";
			args?: string;
	  }
	| {
			cmd: "emulate";
			args: string;
	  }
	| {
			cmd: "throttle";
			args: string;
	  }
	| {
			cmd: "coverage";
			args: string;
	  }
	| {
			cmd: "targets";
			args: string;
	  }
	| {
			cmd: "registers";
	  }
	| {
			cmd: "memory";
			args: string;
	  }
	| {
			cmd: "disasm";
			args?: string;
	  }
);
export interface OkResponse {
	ok: true;
	status?: "paused" | "running";
	phase?: DapSessionPhase;
	file?: string;
	line?: number;
	function?: string;
	columns?: string[];
	rows?: unknown[][];
	value?: string;
	type?: string;
	id?: string;
	connected?: boolean;
	pid?: number;
	messages?: string[];
	latencyMs?: number;
	data?: string;
	s?: string;
	sessions?: SessionInfo[];
	lastErrorCode?: string;
	lastErrorMessage?: string;
	lastStopReason?: string;
	lastStopThreadId?: number;
}
export interface ErrResponse {
	ok: false;
	error: string;
	errorCode?: string;
	phase?: DapSessionPhase;
}
export type Response = OkResponse | ErrResponse;
export interface StoredBreakpoint {
	id: string;
	file: string;
	line: number;
	condition: string;
	hits: number;
	enabled: boolean;
	cdpBreakpointId?: string;
	dapBreakpointId?: number;
}
export interface ScriptInfo {
	id: string;
	file: string;
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
	requestHeaders: string;
	responseHeaders: string;
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
export interface ThreadInfo {
	id: number;
	name: string;
}
export interface RegisterValue {
	name: string;
	value: string;
}
export interface RegisterGroup {
	name: string;
	registers: RegisterValue[];
}
export interface ModuleInfo {
	id: string;
	name: string;
	path: string;
	baseAddress: string;
	size: number;
}
export interface DapStopInfo {
	reason: string;
	threadId: number | null;
	timestamp: number;
}
export interface DapErrorInfo {
	code: string;
	message: string;
	timestamp: number;
}
export interface CdpState {
	lastWsUrl: string | null;
	networkRequests: Map<string, NetworkRequest>;
	pageEvents: PageEvent[];
	wsFrames: WebSocketFrame[];
	coverageSnapshot: CoverageSnapshot | null;
}
export interface DapState {
	threadId: number | null;
	activeThreads: ThreadInfo[];
	registers: RegisterGroup[];
	modules: ModuleInfo[];
	targetTriple: string;
	phase: DapSessionPhase;
	lastStop: DapStopInfo | null;
	lastError: DapErrorInfo | null;
	stopEpoch: number;
}
export interface DebuggerState {
	connected: boolean;
	paused: boolean;
	pid: number | null;
	managedCommand: string | null;
	callFrames: CallFrameInfo[];
	asyncStackTrace: AsyncFrameInfo[];
	breakpoints: Map<string, StoredBreakpoint>;
	scripts: Map<string, ScriptInfo>;
	console: ConsoleEntry[];
	exceptions: ExceptionEntry[];
	cdp?: CdpState;
	dap?: DapState;
}
export type DaemonState = DebuggerState;
export interface Session {
	name: string;
	state: DebuggerState;
	executor: DebugExecutor;
	managedChild: import("node:child_process").ChildProcess | null;
	targetType: "node" | "page" | "native";
	port: number;
	host: string;
	targetUrl?: string;
	targetTitle?: string;
}
export interface SessionInfo {
	name: string;
	connected: boolean;
	paused: boolean;
	targetType: "node" | "page" | "native";
	port: number;
	host: string;
	pid: number | null;
	current: boolean;
	targetUrl?: string;
	targetTitle?: string;
	protocol: SessionProtocol;
}
export declare const CDP_CAPABILITIES: SessionCapabilities;
export declare const DAP_CAPABILITIES: SessionCapabilities;
export declare function createEmptyDebuggerState(): DebuggerState;
//# sourceMappingURL=index.d.ts.map
