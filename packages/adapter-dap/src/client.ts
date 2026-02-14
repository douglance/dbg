import type { DebugProtocol } from "@vscode/debugprotocol";

import * as nodePath from "node:path";
import type {
	CallFrameInfo,
	DapErrorInfo,
	DapSessionPhase,
	DapState,
	DebugExecutor,
	DebuggerState,
	EventStoreLike,
	ScopeInfo,
	SessionCapabilities,
} from "@dbg/types";
import { DAP_CAPABILITIES } from "@dbg/types";

import { launchLldbDap, type LldbLaunchOptions } from "./launch.js";
import {
	DapTransport,
	type DapTransportCloseEvent,
	type DapTransportErrorCode,
} from "./transport.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const ATTACH_REQUEST_TIMEOUT_MS = 45000;
const ATTACH_PAUSE_TIMEOUT_MS = 20000;

export interface LldbLaunchProgramOptions extends LldbLaunchOptions {
	programPath: string;
	cwd?: string;
	args?: string[];
	requestTimeoutMs?: number;
}

export interface LldbAttachToPidOptions extends LldbLaunchOptions {
	pid: number;
	waitFor?: boolean;
	attachCommands?: string[];
	requestTimeoutMs?: number;
}

export interface LldbGdbRemoteOptions extends LldbLaunchOptions {
	gdbRemotePort: number;
	gdbRemoteHostname?: string;
	pid?: number;
	requestTimeoutMs?: number;
}

interface DapBreakpointGroup {
	sourcePath: string;
	breakpoints: Array<{ line: number; condition?: string }>;
}

interface PauseWaiter {
	minStopEpoch: number;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface DapClientErrorLike extends Error {
	code?: string;
}

class DapClientError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DapClientError";
		this.code = code;
	}
}

export class DapClientWrapper implements DebugExecutor {
	readonly protocol = "dap" as const;
	readonly capabilities: SessionCapabilities = DAP_CAPABILITIES;

	private state: DebuggerState;
	private dapState: DapState;
	private store: EventStoreLike | null;
	private transport: DapTransport | null = null;
	private breakpointGroups = new Map<string, DapBreakpointGroup>();
	private waiters: PauseWaiter[] = [];
	private manualClose = false;

	constructor(state: DebuggerState, store?: EventStoreLike | null) {
		this.state = state;
		this.store = store ?? null;
		this.dapState = ensureDapState(this.state);
	}

	getState(): DebuggerState {
		return this.state;
	}

	getStore(): EventStoreLike | null {
		return this.store;
	}

	getPhase(): DapSessionPhase {
		return this.dapState.phase;
	}

	getPauseEpoch(): number {
		return this.dapState.stopEpoch;
	}

	getLastError(): DapErrorInfo | null {
		return this.dapState.lastError;
	}

	async connect(_target: string, _targetType?: "node" | "page"): Promise<void> {
		throw new Error("use attachLldb for dap sessions");
	}

	async attachLldb(options: LldbLaunchProgramOptions): Promise<void> {
		const requestTimeoutMs =
			options.requestTimeoutMs ?? ATTACH_REQUEST_TIMEOUT_MS;
		try {
			this.resetForNewSession();
			await this.startTransport(options);
			this.setPhase("starting");
			await this.initializeSession();
			this.setPhase("configuring");

			await this.requestWithTimeout(
				"launch",
				{
					program: options.programPath,
					cwd: options.cwd,
					args: options.args ?? [],
					stopOnEntry: true,
				},
				requestTimeoutMs,
			);

			await this.requestWithTimeout("configurationDone", undefined, 10000);
			this.state.connected = true;

			await this.waitForPaused(ATTACH_PAUSE_TIMEOUT_MS, 1);
		} catch (error) {
			const message = errorMessage(error);
			this.setFatalError("DAP_ATTACH_FAILED", message);
			await this.safeCloseTransport();
			throw new DapClientError("DAP_ATTACH_FAILED", message);
		}
	}

	async attachLldbToPid(options: LldbAttachToPidOptions): Promise<void> {
		if (!Number.isInteger(options.pid) || options.pid <= 0) {
			throw new DapClientError(
				"DAP_INVALID_PID",
				"pid must be a positive integer",
			);
		}
		const requestTimeoutMs =
			options.requestTimeoutMs ?? ATTACH_REQUEST_TIMEOUT_MS;
		try {
			this.resetForNewSession();
			await this.startTransport(options);
			this.setPhase("starting");
			await this.initializeSession();
			this.setPhase("configuring");

			const attachRequest: Record<string, unknown> = {};
			if (options.attachCommands && options.attachCommands.length > 0) {
				attachRequest.attachCommands = options.attachCommands;
			} else {
				attachRequest.pid = options.pid;
				attachRequest.waitFor = options.waitFor ?? false;
			}
			// lldb-dap uses this configuration timeout (seconds) when waiting for the
			// attached process to reach a stopped state.
			attachRequest.timeout = Math.max(1, Math.ceil(requestTimeoutMs / 1000));

			await this.requestWithTimeout("attach", attachRequest, requestTimeoutMs);
			await this.requestWithTimeout("configurationDone", undefined, 10000);
			this.state.connected = true;

			await this.waitForPaused(ATTACH_PAUSE_TIMEOUT_MS, 1);
		} catch (error) {
			const message = errorMessage(error);
			this.setFatalError("DAP_ATTACH_FAILED", message);
			await this.safeCloseTransport();
			throw new DapClientError("DAP_ATTACH_FAILED", message);
		}
	}

	async attachLldbGdbRemote(options: LldbGdbRemoteOptions): Promise<void> {
		if (
			!Number.isInteger(options.gdbRemotePort) ||
			options.gdbRemotePort <= 0 ||
			options.gdbRemotePort > 65535
		) {
			throw new DapClientError(
				"DAP_INVALID_GDB_REMOTE_PORT",
				"gdbRemotePort must be an integer in range 1-65535",
			);
		}
		if (options.pid !== undefined) {
			if (!Number.isInteger(options.pid) || options.pid <= 0) {
				throw new DapClientError(
					"DAP_INVALID_PID",
					"pid must be a positive integer",
				);
			}
		}
		const requestTimeoutMs =
			options.requestTimeoutMs ?? ATTACH_REQUEST_TIMEOUT_MS;
		try {
			this.resetForNewSession();
			await this.startTransport(options);
			this.setPhase("starting");
			await this.initializeSession();
			this.setPhase("configuring");

			const attachRequest: Record<string, unknown> = {
				"gdb-remote-port": options.gdbRemotePort,
				"gdb-remote-hostname": options.gdbRemoteHostname ?? "127.0.0.1",
				// lldb-dap uses this configuration timeout (seconds) when waiting for the
				// remote process to reach a stopped state.
				timeout: Math.max(1, Math.ceil(requestTimeoutMs / 1000)),
			};
			if (options.pid !== undefined) {
				attachRequest.pid = options.pid;
			}

			await this.requestWithTimeout("attach", attachRequest, requestTimeoutMs);
			await this.requestWithTimeout("configurationDone", undefined, 10000);
			this.state.connected = true;

			await this.waitForPaused(ATTACH_PAUSE_TIMEOUT_MS, 1);
		} catch (error) {
			const message = errorMessage(error);
			this.setFatalError("DAP_ATTACH_FAILED", message);
			await this.safeCloseTransport();
			throw new DapClientError("DAP_ATTACH_FAILED", message);
		}
	}

	async disconnect(): Promise<void> {
		if (!this.transport) return;
		try {
			await this.requestWithTimeout(
				"disconnect",
				{
					restart: false,
					terminateDebuggee: false,
				},
				5000,
			);
		} catch {
			// ignore disconnect request errors
		}
		this.manualClose = true;
		this.transport.close();
		this.transport = null;
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];
		this.setPhase("terminated");
		this.rejectPauseWaiters(
			new DapClientError("DAP_SESSION_TERMINATED", "session disconnected"),
		);
	}

	async waitForPaused(timeoutMs = 30000, minStopEpoch?: number): Promise<void> {
		if (this.isTerminalPhase()) {
			throw this.terminalPhaseError();
		}

		const targetEpoch =
			minStopEpoch ??
			(this.state.paused
				? this.dapState.stopEpoch
				: this.dapState.stopEpoch + 1);

		if (this.state.paused && this.dapState.stopEpoch >= targetEpoch) {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter !== pending);
				reject(
					new DapClientError(
						"DAP_WAIT_FOR_PAUSE_TIMEOUT",
						"timeout waiting for pause",
					),
				);
			}, timeoutMs);
			if (timer.unref) timer.unref();
			const pending: PauseWaiter = {
				minStopEpoch: targetEpoch,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			};
			this.waiters.push(pending);
		});
	}

	async send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<unknown> {
		if (!this.transport || !this.state.connected) {
			throw new DapClientError("DAP_NOT_CONNECTED", "not connected");
		}
		if (this.isTerminalPhase()) {
			throw this.terminalPhaseError();
		}

		switch (method) {
			case "Debugger.resume":
				return this.requestWithTimeout(
					"continue",
					{ threadId: this.requireThreadId() },
					DEFAULT_REQUEST_TIMEOUT_MS,
				);
			case "Debugger.stepInto":
				return this.requestWithTimeout(
					"stepIn",
					{ threadId: this.requireThreadId() },
					DEFAULT_REQUEST_TIMEOUT_MS,
				);
			case "Debugger.stepOver":
				return this.requestWithTimeout(
					"next",
					{ threadId: this.requireThreadId() },
					DEFAULT_REQUEST_TIMEOUT_MS,
				);
			case "Debugger.stepOut":
				return this.requestWithTimeout(
					"stepOut",
					{ threadId: this.requireThreadId() },
					DEFAULT_REQUEST_TIMEOUT_MS,
				);
			case "Debugger.pause":
				return this.requestWithTimeout(
					"pause",
					{ threadId: this.requireThreadId() },
					DEFAULT_REQUEST_TIMEOUT_MS,
				);
			case "Runtime.evaluate":
				return this.evaluateExpression(
					String(params.expression ?? ""),
					undefined,
				);
			case "Debugger.evaluateOnCallFrame": {
				const callFrameId = String(params.callFrameId ?? "");
				const expression = String(params.expression ?? "");
				return this.evaluateExpression(expression, Number(callFrameId));
			}
			case "Runtime.getProperties": {
				const objectId = String(params.objectId ?? "0");
				return this.getProperties(Number.parseInt(objectId, 10));
			}
			case "Debugger.getScriptSource": {
				const scriptId = String(params.scriptId ?? "");
				return this.getScriptSource(scriptId);
			}
			case "Debugger.setBreakpointByUrl":
				return this.setBreakpointByUrl(params);
			case "Debugger.removeBreakpoint":
				return this.removeBreakpoint(String(params.breakpointId ?? ""));
			default:
				return this.requestWithTimeout(
					method,
					params,
					DEFAULT_REQUEST_TIMEOUT_MS,
				);
		}
	}

	private installEventHandlers(): void {
		if (!this.transport) return;

		this.transport.onClose((event) => {
			this.handleTransportClose(event);
		});

		this.transport.onEvent("initialized", () => {
			this.record("initialized", {});
		});

		this.transport.onEvent("stopped", (event) => {
			void this.handleStoppedEvent(event);
		});

		this.transport.onEvent("continued", () => {
			this.state.paused = false;
			this.state.callFrames = [];
			this.state.asyncStackTrace = [];
			this.setPhase("running");
			this.record("continued", {});
		});

		this.transport.onEvent("thread", () => {
			void this.refreshThreads().catch(() => {
				// ignore background refresh failures
			});
		});

		this.transport.onEvent("module", () => {
			void this.refreshModules().catch(() => {
				// ignore background refresh failures
			});
		});

		this.transport.onEvent("terminated", (event) => {
			this.handleTerminated("terminated", event.body);
		});

		this.transport.onEvent("exited", (event) => {
			this.handleTerminated("exited", event.body);
		});

		this.transport.onEvent("output", (event) => {
			this.record("output", { body: event.body });
		});
	}

	private async handleStoppedEvent(event: DebugProtocol.Event): Promise<void> {
		const body = event.body as DebugProtocol.StoppedEvent["body"] | undefined;
		const reason = body?.reason ?? "stopped";
		const threadId = body?.threadId ?? null;

		this.state.connected = true;
		this.state.paused = true;
		this.setPhase("paused");
		this.clearLastError();
		this.dapState.lastStop = {
			reason,
			threadId,
			timestamp: Date.now(),
		};
		if (threadId !== null) {
			this.dapState.threadId = threadId;
		}

		this.record("stopped", {
			reason,
			threadId,
			allThreadsStopped: body?.allThreadsStopped,
		});

		try {
			await this.refreshThreads();
			const selectedThreadId = this.selectThreadId(threadId);
			if (selectedThreadId !== null) {
				await this.refreshFrames(selectedThreadId);
			} else {
				this.state.callFrames = [];
			}
			this.dapState.stopEpoch += 1;
			this.resolvePauseWaiters();
		} catch (error) {
			const message = errorMessage(error);
			const wrapped = new DapClientError(
				"DAP_STOP_PROCESSING_FAILED",
				`failed to process stopped event: ${message}`,
			);
			this.setFatalError(wrapped.code, wrapped.message);
			this.rejectPauseWaiters(wrapped);
		}
	}

	private handleTerminated(
		event: "terminated" | "exited",
		body: unknown,
	): void {
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];
		this.setPhase("terminated");
		this.record("lifecycle", { event, body });
		this.rejectPauseWaiters(
			new DapClientError("DAP_SESSION_TERMINATED", `dap session ${event}`),
		);
	}

	private handleTransportClose(event: DapTransportCloseEvent): void {
		this.transport = null;
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];

		if (this.manualClose) {
			this.manualClose = false;
			this.setPhase("terminated");
			return;
		}

		if (event.error) {
			const code = toClientErrorCode(event.error.code);
			this.setFatalError(code, event.error.message);
		} else {
			this.setPhase("terminated");
		}

		this.record("lifecycle", {
			event: "transport_close",
			reason: event.reason,
			exitCode: event.exitCode,
			signal: event.signal,
			error: event.error?.message,
			stderr: event.stderr,
		});

		this.rejectPauseWaiters(
			new DapClientError(
				event.error
					? toClientErrorCode(event.error.code)
					: "DAP_PROCESS_EXITED",
				event.error?.message ?? "dap process exited",
			),
		);
	}

	private async startTransport(options: LldbLaunchOptions): Promise<void> {
		const child = launchLldbDap(options);
		this.transport = new DapTransport(child);
		this.installEventHandlers();
	}

	private async initializeSession(): Promise<void> {
		await this.requestWithTimeout(
			"initialize",
			{
				adapterID: "lldb",
				clientID: "dbg",
				clientName: "dbg",
				locale: "en-US",
				pathFormat: "path",
				linesStartAt1: true,
				columnsStartAt1: true,
				supportsRunInTerminalRequest: false,
				supportsVariableType: true,
				supportsVariablePaging: false,
				supportsProgressReporting: false,
			},
			10000,
		);
	}

	private async requestWithTimeout(
		command: string,
		argumentsValue: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		if (!this.transport) {
			throw new DapClientError("DAP_NOT_CONNECTED", "not connected");
		}

		const started = Date.now();
		this.record("send", { command, arguments: argumentsValue });
		try {
			const response = await this.transport.request(command, argumentsValue, {
				timeoutMs,
			});
			this.record("recv", {
				command,
				latencyMs: Date.now() - started,
				response,
			});
			return response;
		} catch (error) {
			const converted = toClientError(error, command);
			this.record(
				"error",
				{
					command,
					latencyMs: Date.now() - started,
					error: converted.message,
					code: converted.code,
				},
				true,
			);
			throw converted;
		}
	}

	private async refreshFrames(threadId: number): Promise<void> {
		const response = (await this.requestWithTimeout(
			"stackTrace",
			{
				threadId,
				startFrame: 0,
				levels: 64,
			},
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as { stackFrames?: DebugProtocol.StackFrame[] };

		const frames = response.stackFrames ?? [];
		const mappedFrames: CallFrameInfo[] = [];

		for (const frame of frames) {
			const sourcePath = frame.source?.path ?? frame.source?.name ?? "";
			const scriptId = sourcePath || `frame:${frame.id}`;
			this.state.scripts.set(scriptId, {
				id: scriptId,
				file: sourcePath,
				url: sourcePath,
				lines: 0,
				sourceMap: "",
				isModule: false,
			});

			const scopes = await this.getFrameScopes(frame.id);
			mappedFrames.push({
				callFrameId: String(frame.id),
				functionName: frame.name || "(anonymous)",
				url: sourcePath,
				file: sourcePath,
				line: Math.max(0, (frame.line ?? 1) - 1),
				col: Math.max(0, (frame.column ?? 1) - 1),
				scriptId,
				scopeChain: scopes,
				thisObjectId: "",
			});
		}

		this.state.callFrames = mappedFrames;
	}

	private async getFrameScopes(frameId: number): Promise<ScopeInfo[]> {
		const response = (await this.requestWithTimeout(
			"scopes",
			{ frameId },
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as { scopes?: DebugProtocol.Scope[] };

		return (response.scopes ?? []).map((scope) => ({
			type: scope.name,
			name: scope.name,
			objectId: String(scope.variablesReference),
		}));
	}

	private async refreshThreads(): Promise<void> {
		const response = (await this.requestWithTimeout(
			"threads",
			undefined,
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as {
			threads?: Array<{ id: number; name: string }>;
		};
		this.dapState.activeThreads = (response.threads ?? []).map((thread) => ({
			id: thread.id,
			name: thread.name,
		}));
		if (
			this.dapState.threadId !== null &&
			!this.dapState.activeThreads.some(
				(thread) => thread.id === this.dapState.threadId,
			)
		) {
			this.dapState.threadId = null;
		}
		if (this.dapState.threadId === null && this.dapState.activeThreads[0]) {
			this.dapState.threadId = this.dapState.activeThreads[0].id;
		}
	}

	private async refreshModules(): Promise<void> {
		try {
			const response = (await this.requestWithTimeout(
				"modules",
				undefined,
				DEFAULT_REQUEST_TIMEOUT_MS,
			)) as {
				modules?: Array<{
					id?: string | number;
					name?: string;
					path?: string;
					baseAddress?: string;
					size?: number;
				}>;
			};
			this.dapState.modules = (response.modules ?? []).map((moduleInfo) => ({
				id: String(moduleInfo.id ?? ""),
				name: moduleInfo.name ?? "",
				path: moduleInfo.path ?? "",
				baseAddress: moduleInfo.baseAddress ?? "",
				size: moduleInfo.size ?? 0,
			}));
		} catch {
			// modules request is optional across adapters
		}
	}

	private async evaluateExpression(
		expression: string,
		frameId: number | undefined,
	): Promise<unknown> {
		const response = (await this.requestWithTimeout(
			"evaluate",
			{
				expression,
				frameId,
				context: frameId !== undefined ? "repl" : "watch",
			},
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as {
			result?: string;
			type?: string;
			variablesReference?: number;
		};
		return {
			result: {
				type: response.type ?? inferDapType(response.result),
				value: parseScalar(response.result),
				description: response.result,
				objectId:
					response.variablesReference && response.variablesReference > 0
						? String(response.variablesReference)
						: undefined,
			},
		};
	}

	private async getProperties(variablesReference: number): Promise<unknown> {
		const response = (await this.requestWithTimeout(
			"variables",
			{ variablesReference },
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as {
			variables?: Array<{
				name: string;
				value: string;
				type?: string;
				variablesReference?: number;
			}>;
		};
		return {
			result: (response.variables ?? []).map((variable) => ({
				name: variable.name,
				value: {
					type: variable.type ?? inferDapType(variable.value),
					value: parseScalar(variable.value),
					description: variable.value,
					objectId:
						variable.variablesReference && variable.variablesReference > 0
							? String(variable.variablesReference)
							: undefined,
				},
			})),
		};
	}

	private async getScriptSource(scriptId: string): Promise<unknown> {
		const source = this.state.scripts.get(scriptId);
		if (!source) {
			throw new DapClientError(
				"DAP_UNKNOWN_SCRIPT",
				`unknown script: ${scriptId}`,
			);
		}
		const response = (await this.requestWithTimeout(
			"source",
			{
				source: {
					path: source.file || source.url,
					sourceReference: 0,
				},
			},
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as { content?: string };
		return { scriptSource: response.content ?? "" };
	}

	private async setBreakpointByUrl(
		params: Record<string, unknown>,
	): Promise<unknown> {
		const urlRegex = String(params.urlRegex ?? "");
		const sourcePath = normalizeUrlRegexToPath(urlRegex);
		const lineNumber = Number(params.lineNumber ?? 0) + 1;
		const condition =
			typeof params.condition === "string" ? params.condition : undefined;
		const group = this.breakpointGroups.get(sourcePath) ?? {
			sourcePath,
			breakpoints: [],
		};
		group.breakpoints.push({ line: lineNumber, condition });
		this.breakpointGroups.set(sourcePath, group);

		const response = (await this.requestWithTimeout(
			"setBreakpoints",
			{
				source: { path: sourcePath },
				breakpoints: group.breakpoints.map((bp) => ({
					line: bp.line,
					condition: bp.condition,
				})),
			},
			DEFAULT_REQUEST_TIMEOUT_MS,
		)) as {
			breakpoints?: Array<{
				id?: number;
				line?: number;
				verified?: boolean;
				message?: string;
			}>;
		};
		const last = response.breakpoints?.[response.breakpoints.length - 1];
		const breakpointId = `${sourcePath}:${last?.line ?? lineNumber}`;
		return {
			breakpointId,
			locations: [
				{
					scriptId: sourcePath,
					lineNumber: Math.max(0, (last?.line ?? lineNumber) - 1),
					columnNumber: 0,
				},
			],
			verified: last?.verified ?? false,
			message: last?.message,
		};
	}

	private async removeBreakpoint(breakpointId: string): Promise<unknown> {
		const [sourcePath, lineValue] = breakpointId.split(":");
		const line = Number.parseInt(lineValue ?? "", 10);
		const group = this.breakpointGroups.get(sourcePath);
		if (!group) return {};
		group.breakpoints = group.breakpoints.filter((bp) => bp.line !== line);
		await this.requestWithTimeout(
			"setBreakpoints",
			{
				source: { path: sourcePath },
				breakpoints: group.breakpoints.map((bp) => ({
					line: bp.line,
					condition: bp.condition,
				})),
			},
			DEFAULT_REQUEST_TIMEOUT_MS,
		);
		this.breakpointGroups.set(sourcePath, group);
		return {};
	}

	private resolvePauseWaiters(): void {
		if (this.waiters.length === 0) return;
		const ready = this.waiters.filter(
			(waiter) => this.dapState.stopEpoch >= waiter.minStopEpoch,
		);
		this.waiters = this.waiters.filter(
			(waiter) => this.dapState.stopEpoch < waiter.minStopEpoch,
		);
		for (const waiter of ready) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
	}

	private rejectPauseWaiters(error: Error): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	private requireThreadId(): number {
		const threadId = this.selectThreadId(this.dapState.threadId);
		if (threadId === null) {
			throw new DapClientError("DAP_NO_ACTIVE_THREAD", "no active thread");
		}
		return threadId;
	}

	private selectThreadId(preferredThreadId?: number | null): number | null {
		if (
			preferredThreadId !== undefined &&
			preferredThreadId !== null &&
			this.dapState.activeThreads.some(
				(thread) => thread.id === preferredThreadId,
			)
		) {
			this.dapState.threadId = preferredThreadId;
			return preferredThreadId;
		}

		if (
			this.dapState.threadId !== null &&
			this.dapState.activeThreads.some(
				(thread) => thread.id === this.dapState.threadId,
			)
		) {
			return this.dapState.threadId;
		}

		const fallback = this.dapState.activeThreads[0]?.id ?? null;
		this.dapState.threadId = fallback;
		return fallback;
	}

	private isTerminalPhase(): boolean {
		return (
			this.dapState.phase === "terminated" || this.dapState.phase === "error"
		);
	}

	private terminalPhaseError(): DapClientError {
		if (this.dapState.phase === "error" && this.dapState.lastError) {
			return new DapClientError(
				this.dapState.lastError.code,
				this.dapState.lastError.message,
			);
		}
		return new DapClientError(
			"DAP_SESSION_TERMINATED",
			"session is terminated",
		);
	}

	private setPhase(phase: DapSessionPhase): void {
		this.dapState.phase = phase;
	}

	private setFatalError(code: string, message: string): void {
		this.dapState.lastError = {
			code,
			message,
			timestamp: Date.now(),
		};
		this.setPhase("error");
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];
	}

	private clearLastError(): void {
		this.dapState.lastError = null;
	}

	private resetForNewSession(): void {
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];
		this.dapState.threadId = null;
		this.dapState.activeThreads = [];
		this.dapState.registers = [];
		this.dapState.modules = [];
		this.dapState.targetTriple = "";
		this.dapState.phase = "starting";
		this.dapState.lastStop = null;
		this.dapState.lastError = null;
		this.dapState.stopEpoch = 0;
		this.breakpointGroups.clear();
	}

	private async safeCloseTransport(): Promise<void> {
		if (!this.transport) return;
		this.manualClose = true;
		this.transport.close();
		this.transport = null;
	}

	private record(method: string, data: unknown, flushNow = false): void {
		const source =
			method === "send"
				? "dap_send"
				: method === "recv"
					? "dap_recv"
					: method === "lifecycle"
						? "dap_lifecycle"
						: "dap_event";
		this.store?.record?.(
			{
				source,
				category: "dap",
				method,
				data,
				sessionId: null,
			},
			flushNow,
		);
	}
}

function ensureDapState(state: DebuggerState): DapState {
	if (!state.dap) {
		state.dap = {
			threadId: null,
			activeThreads: [],
			registers: [],
			modules: [],
			targetTriple: "",
			phase: "terminated",
			lastStop: null,
			lastError: null,
			stopEpoch: 0,
		};
	}
	return state.dap;
}

function toClientError(error: unknown, command: string): DapClientError {
	if (error instanceof DapClientError) return error;
	const err = error as DapClientErrorLike;
	if (typeof err?.code === "string") {
		return new DapClientError(toClientErrorCode(err.code), errorMessage(err));
	}
	return new DapClientError(
		"DAP_REQUEST_FAILED",
		`dap request '${command}' failed: ${errorMessage(error)}`,
	);
}

function toClientErrorCode(code: string): string {
	const mapping: Record<DapTransportErrorCode, string> = {
		DAP_TRANSPORT_CLOSED: "DAP_TRANSPORT_CLOSED",
		DAP_PROCESS_EXITED: "DAP_PROCESS_EXITED",
		DAP_REQUEST_TIMEOUT: "DAP_REQUEST_TIMEOUT",
		DAP_PROTOCOL_HEADER_INVALID: "DAP_PROTOCOL_HEADER_INVALID",
		DAP_PROTOCOL_JSON_INVALID: "DAP_PROTOCOL_JSON_INVALID",
		DAP_PROTOCOL_MESSAGE_INVALID: "DAP_PROTOCOL_MESSAGE_INVALID",
		DAP_REQUEST_FAILED: "DAP_REQUEST_FAILED",
	};
	return mapping[code as DapTransportErrorCode] ?? code;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "unknown error";
}

function inferDapType(value: string | undefined): string {
	if (value === undefined) return "undefined";
	if (value === "true" || value === "false") return "boolean";
	if (value === "null") return "null";
	if (!Number.isNaN(Number(value))) return "number";
	if (value.startsWith("{") || value.startsWith("[")) return "object";
	return "string";
}

function parseScalar(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && value.trim() !== "") return parsed;
	return value;
}

function normalizeUrlRegexToPath(urlRegex: string): string {
	const unescaped = urlRegex
		.replace(/^\.\*/, "")
		.replace(/\$$/, "")
		.replace(/\\\./g, ".")
		.replace(/\\\//g, "/")
		.replace(/\\\\/g, "\\");

	if (!unescaped) return urlRegex;
	if (unescaped.includes("://")) return unescaped;
	if (nodePath.isAbsolute(unescaped)) return unescaped;
	return nodePath.resolve(process.cwd(), unescaped);
}
