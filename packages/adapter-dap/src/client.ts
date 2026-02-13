import type { DebugProtocol } from "@vscode/debugprotocol";

import type {
	CallFrameInfo,
	DapState,
	DebugExecutor,
	DebuggerState,
	EventStoreLike,
	ScopeInfo,
	SessionCapabilities,
	StoredBreakpoint,
} from "@dbg/types";
import { DAP_CAPABILITIES } from "@dbg/types";

import { launchLldbDap, type LldbLaunchOptions } from "./launch.js";
import { DapTransport } from "./transport.js";

interface LldbAttachOptions extends LldbLaunchOptions {
	programPath: string;
	cwd?: string;
	args?: string[];
}

interface DapBreakpointGroup {
	sourcePath: string;
	breakpoints: Array<{ line: number; condition?: string }>;
}

export class DapClientWrapper implements DebugExecutor {
	readonly protocol = "dap" as const;
	readonly capabilities: SessionCapabilities = DAP_CAPABILITIES;

	private state: DebuggerState;
	private dapState: DapState;
	private store: EventStoreLike | null;
	private transport: DapTransport | null = null;
	private breakpointGroups = new Map<string, DapBreakpointGroup>();
	private waiters: Array<() => void> = [];

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

	async connect(_target: string, _targetType?: "node" | "page"): Promise<void> {
		throw new Error("use attachLldb for dap sessions");
	}

	async attachLldb(options: LldbAttachOptions): Promise<void> {
		const child = launchLldbDap(options);
		this.transport = new DapTransport(child);
		this.installEventHandlers();

		await this.transport.request("initialize", {
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
		});

		await this.transport.request("launch", {
			program: options.programPath,
			cwd: options.cwd,
			args: options.args ?? [],
			stopOnEntry: true,
		});

		await this.transport.request("configurationDone");
		this.state.connected = true;
	}

	async disconnect(): Promise<void> {
		if (!this.transport) return;
		try {
			await this.transport.request("disconnect", {
				restart: false,
				terminateDebuggee: false,
			});
		} catch {
			// ignore
		}
		this.transport.close();
		this.transport = null;
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];
	}

	async waitForPaused(timeoutMs = 30000): Promise<void> {
		if (this.state.paused) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter !== onStop);
				reject(new Error("timeout waiting for pause"));
			}, timeoutMs);
			const onStop = () => {
				clearTimeout(timer);
				resolve();
			};
			this.waiters.push(onStop);
		});
	}

	async send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<unknown> {
		if (!this.transport) {
			throw new Error("not connected");
		}

		switch (method) {
			case "Debugger.resume":
				return this.transport.request("continue", {
					threadId: this.requireThreadId(),
				});
			case "Debugger.stepInto":
				return this.transport.request("stepIn", {
					threadId: this.requireThreadId(),
				});
			case "Debugger.stepOver":
				return this.transport.request("next", {
					threadId: this.requireThreadId(),
				});
			case "Debugger.stepOut":
				return this.transport.request("stepOut", {
					threadId: this.requireThreadId(),
				});
			case "Debugger.pause":
				return this.transport.request("pause", {
					threadId: this.requireThreadId(),
				});
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
				return this.transport.request(method, params);
		}
	}

	private installEventHandlers(): void {
		if (!this.transport) return;
		this.transport.onEvent("initialized", () => {
			this.record("initialized", {});
		});
		this.transport.onEvent("stopped", (event) => {
			const body = event.body as DebugProtocol.StoppedEvent["body"];
			this.state.paused = true;
			this.dapState.threadId = body.threadId ?? this.dapState.threadId;
			if (body.threadId) {
				void this.refreshFrames(body.threadId);
			}
			this.resolvePauseWaiters();
		});
		this.transport.onEvent("continued", () => {
			this.state.paused = false;
			this.state.callFrames = [];
			this.state.asyncStackTrace = [];
		});
		this.transport.onEvent("thread", () => {
			void this.refreshThreads();
		});
		this.transport.onEvent("module", () => {
			void this.refreshModules();
		});
	}

	private async refreshFrames(threadId: number): Promise<void> {
		if (!this.transport) return;
		const response = (await this.transport.request("stackTrace", {
			threadId,
			startFrame: 0,
			levels: 64,
		})) as { stackFrames?: DebugProtocol.StackFrame[] };

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
		void this.refreshThreads();
	}

	private async getFrameScopes(frameId: number): Promise<ScopeInfo[]> {
		if (!this.transport) return [];
		const response = (await this.transport.request("scopes", {
			frameId,
		})) as { scopes?: DebugProtocol.Scope[] };

		return (response.scopes ?? []).map((scope) => ({
			type: scope.name,
			name: scope.name,
			objectId: String(scope.variablesReference),
		}));
	}

	private async refreshThreads(): Promise<void> {
		if (!this.transport) return;
		const response = (await this.transport.request("threads")) as {
			threads?: Array<{ id: number; name: string }>;
		};
		this.dapState.activeThreads = (response.threads ?? []).map((thread) => ({
			id: thread.id,
			name: thread.name,
		}));
		if (this.dapState.threadId === null && this.dapState.activeThreads[0]) {
			this.dapState.threadId = this.dapState.activeThreads[0].id;
		}
	}

	private async refreshModules(): Promise<void> {
		if (!this.transport) return;
		try {
			const response = (await this.transport.request("modules")) as {
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
			// not supported by all adapters
		}
	}

	private async evaluateExpression(
		expression: string,
		frameId: number | undefined,
	): Promise<unknown> {
		if (!this.transport) throw new Error("not connected");
		const response = (await this.transport.request("evaluate", {
			expression,
			frameId,
			context: frameId !== undefined ? "repl" : "watch",
		})) as {
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
		if (!this.transport) throw new Error("not connected");
		const response = (await this.transport.request("variables", {
			variablesReference,
		})) as {
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
		if (!this.transport) throw new Error("not connected");
		const source = this.state.scripts.get(scriptId);
		if (!source) {
			throw new Error(`unknown script: ${scriptId}`);
		}
		const response = (await this.transport.request("source", {
			source: {
				path: source.file || source.url,
				sourceReference: 0,
			},
		})) as { content?: string };
		return { scriptSource: response.content ?? "" };
	}

	private async setBreakpointByUrl(
		params: Record<string, unknown>,
	): Promise<unknown> {
		if (!this.transport) throw new Error("not connected");

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

		const response = (await this.transport.request("setBreakpoints", {
			source: { path: sourcePath },
			breakpoints: group.breakpoints.map((bp) => ({
				line: bp.line,
				condition: bp.condition,
			})),
		})) as {
			breakpoints?: Array<{
				id?: number;
				line?: number;
				verified?: boolean;
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
		};
	}

	private async removeBreakpoint(breakpointId: string): Promise<unknown> {
		if (!this.transport) throw new Error("not connected");
		const [sourcePath, lineValue] = breakpointId.split(":");
		const line = Number.parseInt(lineValue ?? "", 10);
		const group = this.breakpointGroups.get(sourcePath);
		if (!group) return {};
		group.breakpoints = group.breakpoints.filter((bp) => bp.line !== line);
		await this.transport.request("setBreakpoints", {
			source: { path: sourcePath },
			breakpoints: group.breakpoints.map((bp) => ({
				line: bp.line,
				condition: bp.condition,
			})),
		});
		this.breakpointGroups.set(sourcePath, group);
		return {};
	}

	private resolvePauseWaiters(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter();
	}

	private requireThreadId(): number {
		const threadId =
			this.dapState.threadId ?? this.dapState.activeThreads[0]?.id;
		if (!threadId) {
			throw new Error("no active thread");
		}
		this.dapState.threadId = threadId;
		return threadId;
	}

	private record(method: string, data: unknown): void {
		void method;
		void data;
		void this.store;
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
		};
	}
	return state.dap;
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
	return unescaped || urlRegex;
}
