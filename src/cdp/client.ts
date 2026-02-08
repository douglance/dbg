// CDP client wrapper using chrome-remote-interface
// Tracks debugger state: paused status, call frames, scripts, console, exceptions

import type { EventEmitter } from "node:events";
import type {
	AsyncFrameInfo,
	CdpExecutor,
	DaemonState,
	ScriptInfo,
} from "../protocol.js";
import type { EventStore } from "../store.js";

// chrome-remote-interface has no types; declare what we use
interface CdpClient extends EventEmitter {
	Debugger: {
		enable(): Promise<void>;
		disable(): Promise<void>;
		pause(): Promise<void>;
		resume(): Promise<void>;
		stepOver(): Promise<void>;
		stepInto(): Promise<void>;
		stepOut(): Promise<void>;
		setBreakpoint(params: {
			location: { scriptId: string; lineNumber: number; columnNumber?: number };
			condition?: string;
		}): Promise<{ breakpointId: string; actualLocation: { scriptId: string; lineNumber: number; columnNumber: number } }>;
		removeBreakpoint(params: { breakpointId: string }): Promise<void>;
		getScriptSource(params: { scriptId: string }): Promise<{ scriptSource: string }>;
		evaluateOnCallFrame(params: {
			callFrameId: string;
			expression: string;
			returnByValue?: boolean;
		}): Promise<{ result: { type: string; value?: unknown; description?: string; className?: string }; exceptionDetails?: { text: string } }>;
	};
	Runtime: {
		enable(): Promise<void>;
		disable(): Promise<void>;
		evaluate(params: {
			expression: string;
			returnByValue?: boolean;
		}): Promise<{ result: { type: string; value?: unknown; description?: string; className?: string }; exceptionDetails?: { text: string } }>;
	};
	close(): Promise<void>;
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	emit(eventName: string | symbol, ...args: unknown[]): boolean;
	on(event: string, listener: (...args: unknown[]) => void): this;
	once(event: string, listener: (...args: unknown[]) => void): this;
	removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

export class CdpClientWrapper implements CdpExecutor {
	private client: CdpClient | null = null;
	private state: DaemonState;
	private store: EventStore | null;
	private consoleId = 0;
	private exceptionId = 0;
	private asyncFrameId = 0;
	private sessionId: string | null = null;

	constructor(state: DaemonState, store?: EventStore | null) {
		this.state = state;
		this.store = store ?? null;
	}

	async connect(wsUrl: string): Promise<void> {
		this.sessionId = createSessionId();
		this.recordConnection("connect.start", { wsUrl }, true);

		try {
			const CDP = (await import("chrome-remote-interface")).default;
			// Use local: true to skip protocol fetching from target
			this.client = (await CDP({ target: wsUrl, local: true })) as unknown as CdpClient;

			this.setupEventHandlers();

			// Enable domains with timeouts — some inspectors (e.g. SpacetimeDB)
			// don't implement all domains and will hang on enable().
			await this.enableDomain("Debugger");
			await this.enableDomain("Runtime");
			this.state.connected = true;

			// If target was started with --inspect-brk, it's waiting for a debugger.
			// runIfWaitingForDebugger tells V8 to proceed — which immediately hits
			// the implicit breakpoint and fires Debugger.paused.
			await this.trySend("Runtime.runIfWaitingForDebugger", {});

			// Give the paused event a moment to arrive
			await new Promise((resolve) => setTimeout(resolve, 100));
			this.recordConnection("connect.success", { wsUrl }, true);
		} catch (error) {
			this.recordConnection(
				"connect.error",
				{ wsUrl, error: toErrorMessage(error) },
				true,
			);
			if (this.client) {
				try {
					await this.client.close();
				} catch {
					// ignore close errors
				}
				this.client = null;
			}
			this.state.connected = false;
			this.sessionId = null;
			throw error;
		}
	}

	private async enableDomain(domain: string): Promise<void> {
		try {
			await this.sendWithTimeout(`${domain}.enable`, {}, 5000);
		} catch {
			// Non-fatal: target may not support this domain
		}
	}

	/** Send a CDP command, swallowing errors (for optional features). */
	private async trySend(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		try {
			return await this.sendWithTimeout(method, params, 5000);
		} catch {
			return undefined;
		}
	}

	private setupEventHandlers(): void {
		const client = this.client;
		if (!client) return;
		this.interceptClientEmit(client);

		client.on("Debugger.paused", (params: unknown) => {
			const p = params as {
				callFrames: Array<{
					callFrameId: string;
					functionName: string;
					location: { scriptId: string; lineNumber: number; columnNumber: number };
					url: string;
					scopeChain: Array<{
						type: string;
						name?: string;
						object: { objectId?: string };
					}>;
					this?: { objectId?: string };
				}>;
				asyncStackTrace?: {
					description?: string;
					callFrames: Array<{
						functionName: string;
						url: string;
						lineNumber: number;
						columnNumber: number;
						scriptId: string;
					}>;
					parent?: unknown;
				};
			};
			this.state.paused = true;
			this.state.callFrames = p.callFrames.map((cf) => {
				const scriptInfo = this.state.scripts.get(cf.location.scriptId);
				return {
					callFrameId: cf.callFrameId,
					functionName: cf.functionName || "(anonymous)",
					url: cf.url,
					file: scriptInfo?.file ?? extractFilename(cf.url),
					line: cf.location.lineNumber,
					col: cf.location.columnNumber,
					scriptId: cf.location.scriptId,
					scopeChain: cf.scopeChain.map((s) => ({
						type: s.type,
						name: s.name ?? "",
						objectId: s.object.objectId ?? "",
					})),
					thisObjectId: cf.this?.objectId ?? "",
				};
			});

			// Parse async stack trace
			this.state.asyncStackTrace = [];
			if (p.asyncStackTrace) {
				this.parseAsyncStackTrace(p.asyncStackTrace);
			}
		});

		client.on("Debugger.resumed", () => {
			this.state.paused = false;
			this.state.callFrames = [];
			this.state.asyncStackTrace = [];
		});

		client.on("Debugger.scriptParsed", (params: unknown) => {
			const p = params as {
				scriptId: string;
				url: string;
				startLine: number;
				endLine: number;
				sourceMapURL?: string;
				isModule?: boolean;
			};
			// Skip internal scripts with no URL
			if (!p.url) return;
			const info: ScriptInfo = {
				id: p.scriptId,
				file: extractFilename(p.url),
				url: p.url,
				lines: p.endLine - p.startLine + 1,
				sourceMap: p.sourceMapURL ?? "",
				isModule: p.isModule ?? false,
			};
			this.state.scripts.set(p.scriptId, info);
		});

		client.on("Runtime.consoleAPICalled", (params: unknown) => {
			const p = params as {
				type: string;
				args: Array<{ type: string; value?: unknown; description?: string }>;
				timestamp: number;
				stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> };
			};
			const text = p.args
				.map((a) => {
					if (a.value !== undefined) return String(a.value);
					return a.description ?? `[${a.type}]`;
				})
				.join(" ");
			const stack =
				p.stackTrace?.callFrames
					?.map((f) => `${f.url}:${f.lineNumber}`)
					.join("\n") ?? "";
			this.state.console.push({
				id: ++this.consoleId,
				type: p.type,
				text,
				ts: p.timestamp,
				stack,
			});
		});

		client.on("Runtime.exceptionThrown", (params: unknown) => {
			const p = params as {
				timestamp: number;
				exceptionDetails: {
					text: string;
					exception?: { className?: string; description?: string };
					url?: string;
					lineNumber?: number;
				};
			};
			const ed = p.exceptionDetails;
			this.state.exceptions.push({
				id: ++this.exceptionId,
				text: ed.exception?.description ?? ed.text,
				type: ed.exception?.className ?? "Error",
				file: extractFilename(ed.url ?? ""),
				line: ed.lineNumber ?? 0,
				ts: p.timestamp,
				uncaught: true,
			});
		});
	}

	private interceptClientEmit(client: CdpClient): void {
		const originalEmit = client.emit.bind(client);
		client.emit = ((eventName: string | symbol, ...args: unknown[]) => {
			if (typeof eventName === "string" && eventName.includes(".")) {
				this.recordCdp("cdp_recv", eventName, { event: args[0] });
			}
			return originalEmit(eventName, ...args);
		}) as typeof client.emit;
	}

	private parseAsyncStackTrace(trace: {
		description?: string;
		callFrames: Array<{
			functionName: string;
			url: string;
			lineNumber: number;
			columnNumber: number;
			scriptId: string;
		}>;
		parent?: unknown;
	}): void {
		for (const cf of trace.callFrames) {
			const info: AsyncFrameInfo = {
				id: ++this.asyncFrameId,
				functionName: cf.functionName || "(anonymous)",
				file: extractFilename(cf.url),
				line: cf.lineNumber,
				parentId: null,
				description: trace.description ?? "",
			};
			this.state.asyncStackTrace.push(info);
		}
		if (trace.parent) {
			this.parseAsyncStackTrace(
				trace.parent as typeof trace,
			);
		}
	}

	async send(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		return this.sendWithTimeout(method, params);
	}

	getState(): DaemonState {
		return this.state;
	}

	getStore(): EventStore | null {
		return this.store;
	}

	getClient(): CdpClient | null {
		return this.client;
	}

	/** Wait for the next Debugger.paused event, with a timeout. */
	waitForPaused(timeoutMs = 30000): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.client) {
				reject(new Error("not connected"));
				return;
			}
			const timer = setTimeout(() => {
				this.client?.removeListener("Debugger.paused", handler);
				reject(new Error("timeout waiting for pause"));
			}, timeoutMs);
			const handler = () => {
				clearTimeout(timer);
				resolve();
			};
			this.client.once("Debugger.paused", handler);
		});
	}

	async disconnect(): Promise<void> {
		if (this.client || this.state.connected) {
			this.recordConnection("disconnect", {}, true);
		}

		if (this.client) {
			try {
				await this.client.close();
			} catch {
				// ignore close errors
			}
			this.client = null;
		}
		this.state.connected = false;
		this.state.paused = false;
		this.state.callFrames = [];
		this.state.asyncStackTrace = [];
		this.sessionId = null;
	}

	isConnected(): boolean {
		return this.client !== null && this.state.connected;
	}

	private async sendWithTimeout(
		method: string,
		params?: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<unknown> {
		const client = this.client;
		if (!client) throw new Error("not connected");

		const started = Date.now();
		this.recordCdp("cdp_send", method, { params });

		try {
			const request = client.send(method, params);
			const response = timeoutMs
				? await withTimeout(request, timeoutMs, `${method} timed out`)
				: await request;
			const latencyMs = Date.now() - started;
			this.recordCdp("cdp_recv", method, { response, latencyMs });
			return response;
		} catch (error) {
			const latencyMs = Date.now() - started;
			this.recordCdp(
				"cdp_recv",
				method,
				{
					error: toErrorMessage(error),
					latencyMs,
				},
				true,
			);
			throw error;
		}
	}

	private recordConnection(
		method: string,
		data: unknown,
		flushNow = false,
	): void {
		this.store?.record(
			{
				source: "cdp_client",
				category: "connection",
				method,
				data,
				sessionId: this.sessionId,
			},
			flushNow,
		);
	}

	private recordCdp(
		source: "cdp_send" | "cdp_recv",
		method: string,
		data: unknown,
		flushNow = false,
	): void {
		this.store?.record(
			{
				source,
				category: "cdp",
				method,
				data,
				sessionId: this.sessionId,
			},
			flushNow,
		);
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

function extractFilename(url: string): string {
	if (!url) return "";
	// Handle file:// URLs
	if (url.startsWith("file://")) {
		return url.slice(7);
	}
	// Handle bare paths
	if (url.startsWith("/")) {
		return url;
	}
	// Strip query/hash
	const clean = url.split("?")[0].split("#")[0];
	// Return last path segment
	const parts = clean.split("/");
	return parts[parts.length - 1] || url;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function createSessionId(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
