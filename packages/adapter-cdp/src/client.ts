// CDP client wrapper using chrome-remote-interface
// Tracks debugger state: paused status, call frames, scripts, console, exceptions

import type { EventEmitter } from "node:events";
import type {
	AsyncFrameInfo,
	CdpState,
	DebugExecutor,
	DebuggerState,
	ScriptInfo,
} from "@dbg/types";
import { CDP_CAPABILITIES } from "@dbg/types";
import type { EventStore } from "@dbg/store";

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
		}): Promise<{
			breakpointId: string;
			actualLocation: {
				scriptId: string;
				lineNumber: number;
				columnNumber: number;
			};
		}>;
		removeBreakpoint(params: { breakpointId: string }): Promise<void>;
		getScriptSource(params: { scriptId: string }): Promise<{
			scriptSource: string;
		}>;
		evaluateOnCallFrame(params: {
			callFrameId: string;
			expression: string;
			returnByValue?: boolean;
		}): Promise<{
			result: {
				type: string;
				value?: unknown;
				description?: string;
				className?: string;
			};
			exceptionDetails?: { text: string };
		}>;
	};
	Runtime: {
		enable(): Promise<void>;
		disable(): Promise<void>;
		evaluate(params: {
			expression: string;
			returnByValue?: boolean;
		}): Promise<{
			result: {
				type: string;
				value?: unknown;
				description?: string;
				className?: string;
			};
			exceptionDetails?: { text: string };
		}>;
	};
	close(): Promise<void>;
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	emit(eventName: string | symbol, ...args: unknown[]): boolean;
	on(event: string, listener: (...args: unknown[]) => void): this;
	once(event: string, listener: (...args: unknown[]) => void): this;
	removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

export class CdpClientWrapper implements DebugExecutor {
	readonly protocol = "cdp" as const;
	readonly capabilities = CDP_CAPABILITIES;
	private client: CdpClient | null = null;
	private state: DebuggerState;
	private cdpState: CdpState;
	private store: EventStore | null;
	private consoleId = 0;
	private exceptionId = 0;
	private asyncFrameId = 0;
	private pageEventId = 0;
	private wsFrameId = 0;
	private sessionId: string | null = null;
	private mockRules: Map<string, { body: string; status: number }> = new Map();

	constructor(state: DebuggerState, store?: EventStore | null) {
		this.cdpState = ensureCdpState(state);
		this.state = state;
		this.store = store ?? null;
	}

	async connect(wsUrl: string, targetType?: "node" | "page"): Promise<void> {
		this.sessionId = createSessionId();
		this.recordConnection("connect.start", { wsUrl, targetType }, true);

		try {
			const CDP = (await import("chrome-remote-interface")).default;
			// Use local: true to skip protocol fetching from target
			this.client = (await CDP({
				target: wsUrl,
				local: true,
			})) as unknown as CdpClient;

			this.setupEventHandlers();

			// Enable domains with timeouts — some inspectors (e.g. SpacetimeDB)
			// don't implement all domains and will hang on enable().
			await this.enableDomain("Debugger");
			await this.enableDomain("Runtime");

			// Enable browser-specific domains for page targets
			if (targetType === "page") {
				const browserDomains = [
					"Network",
					"Page",
					"DOM",
					"CSS",
					"Log",
					"Performance",
					"DOMStorage",
					"Fetch",
					"Input",
				];
				for (const domain of browserDomains) {
					await this.enableDomain(domain);
				}
			}

			this.state.connected = true;

			// If target was started with --inspect-brk, it's waiting for a debugger.
			// runIfWaitingForDebugger tells V8 to proceed — which immediately hits
			// the implicit breakpoint and fires Debugger.paused.
			await this.trySend("Runtime.runIfWaitingForDebugger", {});

			// Give the paused event a moment to arrive
			await new Promise((resolve) => setTimeout(resolve, 100));
			this.recordConnection("connect.success", { wsUrl, targetType }, true);
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
					location: {
						scriptId: string;
						lineNumber: number;
						columnNumber: number;
					};
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

		// ─── Browser event handlers (page targets) ───

		client.on("Network.requestWillBeSent", (params: unknown) => {
			const p = params as {
				requestId: string;
				request: {
					url: string;
					method: string;
					headers: Record<string, string>;
				};
				timestamp: number;
				initiator: { type: string; url?: string };
				type?: string;
			};
			this.cdpState.networkRequests.set(p.requestId, {
				id: p.requestId,
				url: p.request.url,
				method: p.request.method,
				status: 0,
				type: p.type ?? "",
				mimeType: "",
				startTime: p.timestamp,
				endTime: 0,
				duration: 0,
				size: 0,
				error: "",
				requestHeaders: JSON.stringify(p.request.headers),
				responseHeaders: "",
				initiator: p.initiator.type,
			});
			if (this.cdpState.networkRequests.size > 10000) {
				const firstKey = this.cdpState.networkRequests.keys().next().value;
				if (firstKey !== undefined)
					this.cdpState.networkRequests.delete(firstKey);
			}
		});

		client.on("Network.responseReceived", (params: unknown) => {
			const p = params as {
				requestId: string;
				response: {
					status: number;
					headers: Record<string, string>;
					mimeType: string;
				};
				type?: string;
			};
			const entry = this.cdpState.networkRequests.get(p.requestId);
			if (entry) {
				entry.status = p.response.status;
				entry.mimeType = p.response.mimeType;
				entry.responseHeaders = JSON.stringify(p.response.headers);
				if (p.type) entry.type = p.type;
			}
		});

		client.on("Network.loadingFinished", (params: unknown) => {
			const p = params as {
				requestId: string;
				timestamp: number;
				encodedDataLength: number;
			};
			const entry = this.cdpState.networkRequests.get(p.requestId);
			if (entry) {
				entry.endTime = p.timestamp;
				entry.size = p.encodedDataLength;
				entry.duration = (entry.endTime - entry.startTime) * 1000;
			}
		});

		client.on("Network.loadingFailed", (params: unknown) => {
			const p = params as {
				requestId: string;
				errorText: string;
			};
			const entry = this.cdpState.networkRequests.get(p.requestId);
			if (entry) {
				entry.error = p.errorText;
			}
		});

		client.on("Network.webSocketFrameReceived", (params: unknown) => {
			const p = params as {
				requestId: string;
				timestamp: number;
				response: { opcode: number; payloadData: string };
			};
			this.cdpState.wsFrames.push({
				id: ++this.wsFrameId,
				requestId: p.requestId,
				opcode: p.response.opcode,
				data: p.response.payloadData,
				ts: p.timestamp,
				direction: "received",
			});
			if (this.cdpState.wsFrames.length > 5000) {
				this.cdpState.wsFrames.shift();
			}
		});

		client.on("Network.webSocketFrameSent", (params: unknown) => {
			const p = params as {
				requestId: string;
				timestamp: number;
				response: { opcode: number; payloadData: string };
			};
			this.cdpState.wsFrames.push({
				id: ++this.wsFrameId,
				requestId: p.requestId,
				opcode: p.response.opcode,
				data: p.response.payloadData,
				ts: p.timestamp,
				direction: "sent",
			});
			if (this.cdpState.wsFrames.length > 5000) {
				this.cdpState.wsFrames.shift();
			}
		});

		client.on("Page.lifecycleEvent", (params: unknown) => {
			const p = params as {
				name: string;
				timestamp: number;
				frameId: string;
			};
			this.cdpState.pageEvents.push({
				id: ++this.pageEventId,
				name: p.name,
				ts: p.timestamp,
				frameId: p.frameId,
				url: "",
			});
			if (this.cdpState.pageEvents.length > 5000) {
				this.cdpState.pageEvents.shift();
			}
		});

		client.on("Page.frameNavigated", (params: unknown) => {
			const p = params as {
				frame: { id: string; url: string };
			};
			this.cdpState.pageEvents.push({
				id: ++this.pageEventId,
				name: "frameNavigated",
				ts: Date.now(),
				frameId: p.frame.id,
				url: p.frame.url,
			});
			if (this.cdpState.pageEvents.length > 5000) {
				this.cdpState.pageEvents.shift();
			}
		});

		client.on("Log.entryAdded", (params: unknown) => {
			const p = params as {
				entry: {
					level: string;
					text: string;
					timestamp: number;
					url?: string;
					stackTrace?: {
						callFrames: Array<{ url: string; lineNumber: number }>;
					};
				};
			};
			const stack =
				p.entry.stackTrace?.callFrames
					?.map((f) => `${f.url}:${f.lineNumber}`)
					.join("\n") ?? "";
			this.state.console.push({
				id: ++this.consoleId,
				type: p.entry.level,
				text: p.entry.text,
				ts: p.entry.timestamp,
				stack,
			});
		});

		client.on("Fetch.requestPaused", (params: unknown) => {
			const p = params as {
				requestId: string;
				request: { url: string; method: string };
			};

			// Check mock rules
			for (const [pattern, rule] of this.mockRules) {
				if (p.request.url.includes(pattern)) {
					// Fulfill with mock response
					const headers = [
						{ name: "Content-Type", value: "application/json" },
						{ name: "Access-Control-Allow-Origin", value: "*" },
					];
					this.trySend("Fetch.fulfillRequest", {
						requestId: p.requestId,
						responseCode: rule.status,
						responseHeaders: headers,
						body: Buffer.from(rule.body).toString("base64"),
					});
					return;
				}
			}

			// No mock match — continue request normally
			this.trySend("Fetch.continueRequest", {
				requestId: p.requestId,
			});
		});
	}

	private interceptClientEmit(client: CdpClient): void {
		const originalEmit = client.emit.bind(client);
		client.emit = ((eventName: string | symbol, ...args: unknown[]) => {
			if (typeof eventName === "string" && eventName.includes(".")) {
				const normalizedMethod = normalizeIncomingEventMethod(eventName);
				if (normalizedMethod) {
					this.recordCdp("cdp_recv", normalizedMethod, { event: args[0] });
				}
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
			this.parseAsyncStackTrace(trace.parent as typeof trace);
		}
	}

	async send(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		return this.sendWithTimeout(method, params);
	}

	getState(): DebuggerState {
		return this.state;
	}

	getStore(): EventStore | null {
		return this.store;
	}

	getClient(): CdpClient | null {
		return this.client;
	}

	addMockRule(urlPattern: string, body: string, status: number): void {
		this.mockRules.set(urlPattern, { body, status });
	}

	removeMockRule(urlPattern: string): boolean {
		return this.mockRules.delete(urlPattern);
	}

	clearMockRules(): void {
		this.mockRules.clear();
	}

	getMockRules(): Map<string, { body: string; status: number }> {
		return this.mockRules;
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
		this.cdpState.networkRequests.clear();
		this.cdpState.pageEvents = [];
		this.cdpState.wsFrames = [];
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

function normalizeIncomingEventMethod(method: string): string | null {
	// chrome-remote-interface can emit duplicate CDP events with a trailing
	// ".undefined" suffix. The unsuffixed event is emitted as well, so skip the
	// suffixed duplicate to keep event logs canonical.
	if (method.endsWith(".undefined")) {
		return null;
	}
	return method;
}

function createSessionId(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function ensureCdpState(state: DebuggerState): CdpState {
	if (!state.cdp) {
		state.cdp = {
			lastWsUrl: null,
			networkRequests: new Map(),
			pageEvents: [],
			wsFrames: [],
			coverageSnapshot: null,
		};
	}
	return state.cdp;
}
