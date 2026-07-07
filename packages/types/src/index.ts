// Shared protocol and state types used across packages.

export const SOCKET_PATH = process.env.DBG_SOCK ?? "/tmp/dbg.sock";

export type SessionProtocol = "cdp" | "dap";
export type AttachProvider = "apple-device";
export type AttachPlatform = "auto" | "ios" | "tvos" | "watchos" | "visionos";
export type AttachStrategy = "auto" | "device-process" | "gdb-remote";
export type DapSessionPhase =
	| "starting"
	| "configuring"
	| "paused"
	| "running"
	| "terminated"
	| "error";

export interface AttachRequest {
	provider: AttachProvider;
	platform: AttachPlatform;
	bundleId: string;
	device?: string;
	pid?: number;
	launch?: boolean;
	protocol?: SessionProtocol;
	attachStrategy?: AttachStrategy;
	attachTimeoutMs?: number;
	verbose?: boolean;
}

export interface ProviderResolutionResult {
	provider: AttachProvider;
	platform: AttachPlatform;
	deviceId: string;
	bundleId: string;
	pid: number;
	attachProtocol: "dap";
	metadata?: Record<string, unknown>;
}

export type ProviderErrorCode =
	| "invalid_request"
	| "device_not_found"
	| "ambiguous_device_selection"
	| "app_not_installed"
	| "process_not_running"
	| "attach_denied_or_timeout"
	| "lldb_dap_unavailable"
	| "provider_error";

export interface ProviderError {
	code: ProviderErrorCode;
	message: string;
	details?: Record<string, unknown>;
}

export interface AttachDiagnostics {
	requestedStrategy: AttachStrategy;
	attemptedStrategies: Array<{
		strategy: AttachStrategy;
		durationMs: number;
		success: boolean;
		error?: string;
	}>;
	selectedStrategy: AttachStrategy | null;
	providerResolveMs: number;
	totalMs: number;
}

export interface SessionCapabilities {
	// Universal
	breakpoints: boolean;
	stepping: boolean;
	evaluation: boolean;
	stackFrames: boolean;
	variables: boolean;
	sourceView: boolean;
	// Browser-only
	dom: boolean;
	css: boolean;
	network: boolean;
	page: boolean;
	storage: boolean;
	emulation: boolean;
	coverage: boolean;
	// Native-only
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

// Backwards-compat alias during migration.
export type CdpExecutor = DebugExecutor;

// CLI <-> Daemon wire protocol
//
// Each Command variant carries typed, already-parsed payload fields so the
// daemon never has to re-parse a freeform string. A `session?: string`
// field identifies the target debug session for any command where a
// session context is meaningful. Commands that operate outside any
// session (session management itself, target/device enumeration) omit
// `session` — see inline comments on each variant.
export type SessionScoped<T> = T & { session?: string };

export type NavigateAction =
	| { action: "reload" }
	| { action: "back" }
	| { action: "forward" }
	| { action: "url"; url: string };

export type CoverageAction = "start" | "stop";

export type Command =
	// ─── Lifecycle ───
	// Connect to a running debug target by port (auto-discover websocket).
	| SessionScoped<{
			cmd: "open";
			port: number;
			host?: string;
			type?: "page" | "node";
			target?: string;
	  }>
	// Attach to an app on an Apple device/simulator via a provider.
	| SessionScoped<{
			cmd: "attach";
			provider: AttachProvider;
			platform: AttachPlatform;
			bundleId: string;
			device?: string;
			pid?: number;
			launch?: boolean;
			attachStrategy?: AttachStrategy;
			attachTimeoutMs?: number;
			verbose?: boolean;
	  }>
	// Launch lldb-dap against a local native binary.
	| SessionScoped<{ cmd: "attach-lldb"; program: string; args?: string[] }>
	// Disconnect the session (and kill any managed child process).
	| SessionScoped<{ cmd: "close" }>
	// Spawn a Node process with --inspect-brk and attach.
	| SessionScoped<{ cmd: "run"; command: string }>
	// Kill and respawn the managed child, reconnect, re-apply breakpoints.
	| SessionScoped<{ cmd: "restart" }>
	// Connection/pause state snapshot for the session.
	| SessionScoped<{ cmd: "status" }>

	// ─── Flow control ───
	// Continue execution.
	| SessionScoped<{ cmd: "c" }>
	// Step into.
	| SessionScoped<{ cmd: "s" }>
	// Step over.
	| SessionScoped<{ cmd: "n" }>
	// Step out.
	| SessionScoped<{ cmd: "o" }>
	// Pause execution.
	| SessionScoped<{ cmd: "pause" }>

	// ─── Breakpoints ───
	// Set a breakpoint by file:line with an optional condition expression.
	| SessionScoped<{
			cmd: "b";
			file: string;
			line: number;
			condition?: string;
	  }>
	// Delete a breakpoint by its debugger-assigned id.
	| SessionScoped<{ cmd: "db"; id: string }>
	// List all breakpoints for the session.
	| SessionScoped<{ cmd: "bl" }>

	// ─── Inspection ───
	// Evaluate an expression in the current frame.
	| SessionScoped<{ cmd: "e"; expression: string }>
	// View source. If file is omitted, uses the current paused frame;
	// otherwise all three (file, start, end) must be provided.
	| SessionScoped<{
			cmd: "src";
			file?: string;
			start?: number;
			end?: number;
	  }>
	// Recent protocol send/recv history from the event store.
	| SessionScoped<{ cmd: "trace"; limit?: number }>
	// Probe Runtime.evaluate("1+1") and report latency.
	| SessionScoped<{ cmd: "health" }>
	// Reconnect to the last known websocket URL.
	| SessionScoped<{ cmd: "reconnect" }>

	// ─── Query ───
	// Run a SQL query against the table registry for this session.
	// JSON rendering (\j) is a CLI-side formatting concern and is not
	// carried in the payload. `cwd` is the CLIENT's working directory,
	// threaded so dev tables (commits/agent_prompts/agent_sessions) scope to
	// the user's project rather than the daemon's cwd.
	| SessionScoped<{ cmd: "q"; sql: string; cwd?: string }>

	// ─── Sessions ───
	// Global: list all sessions. No `session` field (operates on the registry).
	| { cmd: "ss" }
	// Global: switch the current session pointer. `name` is the session,
	// not a target — no `session` field.
	| { cmd: "use"; name: string }

	// ─── Browser automation (CDP only) ───
	// Navigate: url|reload|back|forward. Encoded as a discriminated sub-union.
	| SessionScoped<{ cmd: "navigate"; action: NavigateAction }>
	// Capture a PNG screenshot. If `path` is set, saves to disk; otherwise
	// returns base64 in the response.
	| SessionScoped<{ cmd: "screenshot"; path?: string }>
	// Click an element by CSS selector.
	| SessionScoped<{ cmd: "click"; selector: string }>
	// Type text into an element.
	| SessionScoped<{ cmd: "type"; selector: string; text: string }>
	// Select a <select> option by value.
	| SessionScoped<{ cmd: "select"; selector: string; value: string }>
	// Register a network mock: urlPattern + response body + optional status.
	| SessionScoped<{
			cmd: "mock";
			urlPattern: string;
			body: string;
			status?: number;
	  }>
	// Remove mock(s). Omit `pattern` to clear all.
	| SessionScoped<{ cmd: "unmock"; pattern?: string }>
	// Emulate a mobile device by preset name, or "reset" to clear.
	| SessionScoped<{ cmd: "emulate"; preset: string }>
	// Network throttling preset: 3g, slow-3g, fast-3g, 4g, offline, off.
	| SessionScoped<{ cmd: "throttle"; preset: string }>
	// Start/stop JS + CSS coverage tracking.
	| SessionScoped<{ cmd: "coverage"; action: CoverageAction }>

	// ─── Recording (visual flight recorder; global — one recorder per daemon) ───
	// Launch managed headless Chrome, attach as a named session, capture an
	// initial frame, and keep recording until record.stop.
	| {
			cmd: "record.start";
			urls: string[];
			viewport?: { width: number; height: number };
			// FS quiet period (ms) that starts a new auto epoch; default 10000.
			idleThresholdMs?: number;
			// Retention: max full-resolution frames kept per session (default 200);
			// over budget, non-protected frames decay to thumb, then metadata-only.
			maxFrames?: number;
			// Retention: max total blob bytes per session (default 100MB).
			maxBytes?: number;
			// TTL for raw CDP `events` rows while recording (default 30min);
			// the most-recent 50k rows are always kept.
			eventsTtlMs?: number;
	  }
	// Stop recording: detach, kill the managed Chrome, clear recorder state.
	| { cmd: "record.stop" }
	// Recorder state snapshot: {running, pid, port, urls, frameCount}.
	| { cmd: "record.status" }
	// Stamp a named epoch (auto=0) in the recording timeline.
	| { cmd: "record.mark"; name?: string }
	// Capture now and diff vs an anchor capture (see AnchorSpec kinds):
	// at = "capture:<id>" | "mark:<name>" | "time:<ts>" | "file:<path>".
	// Writes report.html; open=true additionally spawns `open`.
	| { cmd: "record.after"; at?: string; open?: boolean }
	// Render the timeline filmstrip HTML from recorded captures.
	// limit = max most-recent frames embedded (default 100).
	| { cmd: "record.timeline"; open?: boolean; limit?: number }
	// Restore a capture's URL/scroll in the recorder page.
	| { cmd: "record.replay"; capture: number }
	// Blame the most recent (or substring-matched) error: walk the timeline
	// back to ranked causes (edits/epoch/commit/prompt). `cwd` scopes the dev
	// tables to the user's project (see `q`).
	| { cmd: "why"; substring?: string; cwd?: string }
	// One-off deliberate capture: URL, or a component file rendered in an
	// esbuild harness (#dbg-root). Launches a throwaway Chrome; `states` are
	// forced via CSS.forcePseudoState and each produces its own PNG.
	| {
			cmd: "record.shoot";
			target: string;
			selector?: string;
			viewport?: { width: number; height: number };
			fullPage?: boolean;
			states?: string[];
			props?: string;
			name?: string;
			out?: string;
	  }

	// ─── Target/device enumeration (global) ───
	// List debuggable targets at a port. No `session`: discovery endpoint.
	| { cmd: "targets"; port: number; host?: string }
	// List Apple devices + simulators. No `session`: global enumeration.
	| {
			cmd: "devices";
			platform?: AttachPlatform;
	  }
	// List installed apps on an Apple device/simulator. No `session`.
	| { cmd: "apps"; deviceId: string }

	// ─── Native debug (DAP / LLDB only) ───
	// Dump register values.
	| SessionScoped<{ cmd: "registers" }>
	// Read `length` bytes starting at `address` (hex or decimal string).
	| SessionScoped<{ cmd: "memory"; address: string; length: number }>
	// Disassemble around `address`, or the current frame when omitted.
	| SessionScoped<{ cmd: "disasm"; address?: string }>;

export interface AfterDeltaEntry {
	type: string;
	text: string;
	ts: number;
}

export interface AfterNetworkFailure {
	url: string;
	ts: number;
	method?: string;
	status?: number;
	error?: string;
}

export interface AfterRegion {
	box: { x: number; y: number; w: number; h: number };
	/** Component name, or a tag.class fallback on non-React pages. */
	label: string;
	component: string | null;
	file: string | null;
	/** True when the region's component file matches a changed/HMR'd file. */
	causal: boolean;
}

export interface AfterStyleChange {
	selector: string;
	prop: string;
	before: string;
	after: string;
}

export interface AfterNetEntry {
	method: string;
	pattern: string;
	url: string;
	status: number;
	durationMs: number;
}

export interface AfterNetStatusChange {
	method: string;
	pattern: string;
	url: string;
	before: number;
	after: number;
}

export interface AfterNetDurationDelta {
	method: string;
	pattern: string;
	url: string;
	beforeMs: number;
	afterMs: number;
	deltaMs: number;
}

export interface AfterNetworkDiff {
	added: AfterNetEntry[];
	removed: AfterNetEntry[];
	statusChanged: AfterNetStatusChange[];
	durationDelta: AfterNetDurationDelta[];
}

export interface AfterStateChange {
	kind: string;
	key: string;
	change: string;
	before: unknown;
	after: unknown;
}

export interface AfterA11yIssue {
	rule: string;
	selector: string;
	detail: string;
}

export interface WhyVerdict {
	error: { text: string; ts: number };
	edits: Array<{
		path: string;
		ts: number;
		score: number;
		inStack: boolean;
		msBefore: number;
	}>;
	epoch: { id: number; name: string | null; ts: number } | null;
	commit: { shortHash: string; summary: string; ts: number } | null;
	prompt: { display: string; ts: number } | null;
	answer: string;
}

export interface AfterPair {
	name: string;
	baseline: { captureId: number; ts: number };
	after: { captureId: number; ts: number };
	diffPercent: number;
	diffPixels: number;
	dimensionsChanged: boolean;
	/** Number of changed-pixel clusters. */
	clusters: number;
}

export interface RecordingStatus {
	running: boolean;
	pid?: number;
	port?: number;
	urls?: string[];
	frameCount?: number;
	session?: string;
	lastCaptureTs?: number | null;
	captureCount?: number;
	epochCount?: number;
	// ── Retention visibility ──
	/** Total bytes of live capture blobs (PNGs + snapshots) on disk. */
	diskBytes?: number;
	fullFrames?: number;
	thumbFrames?: number;
	metaFrames?: number;
	/** Raw CDP `events` rows currently in the store. */
	eventsRows?: number;
}

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
	recording?: RecordingStatus;
	// record.after result (dbg after)
	pair?: AfterPair;
	consoleDelta?: { new: AfterDeltaEntry[] };
	exceptionDelta?: { new: AfterDeltaEntry[] };
	networkDelta?: { failed: AfterNetworkFailure[] };
	// ── Plan V verdicts ──
	networkDiff?: AfterNetworkDiff;
	stateChanges?: AfterStateChange[];
	a11yNew?: AfterA11yIssue[];
	why?: WhyVerdict;
	regions?: AfterRegion[];
	styleChanges?: AfterStyleChange[];
	reportPath?: string;
	// record.shoot results, one per captured state ("default" first)
	shots?: Array<{ state: string; path: string }>;
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
	instructionAddress?: string;
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

// Backwards-compat alias during migration.
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

export const CDP_CAPABILITIES: SessionCapabilities = {
	breakpoints: true,
	stepping: true,
	evaluation: true,
	stackFrames: true,
	variables: true,
	sourceView: true,
	dom: true,
	css: true,
	network: true,
	page: true,
	storage: true,
	emulation: true,
	coverage: true,
	registers: false,
	memory: false,
	disassembly: false,
	watchpoints: false,
};

export const DAP_CAPABILITIES: SessionCapabilities = {
	breakpoints: true,
	stepping: true,
	evaluation: true,
	stackFrames: true,
	variables: true,
	sourceView: true,
	dom: false,
	css: false,
	network: false,
	page: false,
	storage: false,
	emulation: false,
	coverage: false,
	registers: true,
	memory: true,
	disassembly: true,
	watchpoints: true,
};

export function createEmptyDebuggerState(): DebuggerState {
	return {
		connected: false,
		paused: false,
		pid: null,
		managedCommand: null,
		callFrames: [],
		asyncStackTrace: [],
		breakpoints: new Map(),
		scripts: new Map(),
		console: [],
		exceptions: [],
		cdp: {
			lastWsUrl: null,
			networkRequests: new Map(),
			pageEvents: [],
			wsFrames: [],
			coverageSnapshot: null,
		},
		dap: {
			threadId: null,
			activeThreads: [],
			registers: [],
			modules: [],
			targetTriple: "",
			phase: "terminated",
			lastStop: null,
			lastError: null,
			stopEpoch: 0,
		},
	};
}
