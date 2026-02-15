import type { DebugProtocol } from "@vscode/debugprotocol";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type DapTransportErrorCode =
	| "DAP_TRANSPORT_CLOSED"
	| "DAP_PROCESS_EXITED"
	| "DAP_REQUEST_TIMEOUT"
	| "DAP_PROTOCOL_HEADER_INVALID"
	| "DAP_PROTOCOL_JSON_INVALID"
	| "DAP_PROTOCOL_MESSAGE_INVALID"
	| "DAP_REQUEST_FAILED";

export class DapTransportError extends Error {
	readonly code: DapTransportErrorCode;

	constructor(code: DapTransportErrorCode, message: string) {
		super(message);
		this.name = "DapTransportError";
		this.code = code;
	}
}

export interface DapTransportRequestOptions {
	timeoutMs?: number;
}

export interface DapTransportCloseEvent {
	reason: "exit" | "close" | "protocol_error" | "manual_close";
	error: DapTransportError | null;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

interface PendingRequest {
	command: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | null;
}

export class DapTransport {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly eventHandlers = new Map<
		string,
		Array<(event: DebugProtocol.Event) => void>
	>();
	private readonly responseHandlers = new Map<
		string,
		Array<(response: DebugProtocol.Response) => void>
	>();
	private readonly closeHandlers: Array<
		(event: DapTransportCloseEvent) => void
	> = [];
	private seq = 1;
	private buffer = Buffer.alloc(0);
	private closed = false;
	private stderrTail = "";
	private static readonly STDERR_LIMIT = 2048;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			try {
				this.processBuffer();
			} catch (error) {
				this.failTransport(
					"protocol_error",
					asTransportError(
						error,
						"DAP_PROTOCOL_MESSAGE_INVALID",
						"failed to process dap message",
					),
					null,
					null,
				);
			}
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			const next = `${this.stderrTail}${chunk.toString("utf8")}`;
			this.stderrTail = next.slice(-DapTransport.STDERR_LIMIT);
		});
		this.child.on("exit", (code, signal) => {
			this.failTransport(
				"exit",
				new DapTransportError(
					"DAP_PROCESS_EXITED",
					this.withStderrContext("dap process exited"),
				),
				code,
				signal,
			);
		});
		this.child.on("close", (code, signal) => {
			this.failTransport(
				"close",
				new DapTransportError(
					"DAP_PROCESS_EXITED",
					this.withStderrContext("dap process closed"),
				),
				code,
				signal,
			);
		});
	}

	onEvent(event: string, handler: (event: DebugProtocol.Event) => void): void {
		const handlers = this.eventHandlers.get(event) ?? [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	onResponse(
		command: string,
		handler: (response: DebugProtocol.Response) => void,
	): void {
		const handlers = this.responseHandlers.get(command) ?? [];
		handlers.push(handler);
		this.responseHandlers.set(command, handlers);
	}

	onClose(handler: (event: DapTransportCloseEvent) => void): void {
		this.closeHandlers.push(handler);
	}

	async request(
		command: string,
		argumentsValue?: unknown,
		options: DapTransportRequestOptions = {},
	): Promise<unknown> {
		if (this.closed) {
			throw new DapTransportError(
				"DAP_TRANSPORT_CLOSED",
				this.withStderrContext("dap transport is closed"),
			);
		}
		const seq = this.seq++;
		const request: DebugProtocol.Request = {
			type: "request",
			seq,
			command,
			arguments: argumentsValue as DebugProtocol.Request["arguments"],
		};
		this.writeMessage(request);
		return new Promise((resolve, reject) => {
			const timeoutMs = options.timeoutMs;
			let timer: NodeJS.Timeout | null = null;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timer = setTimeout(() => {
					const pending = this.pending.get(seq);
					if (!pending) return;
					this.pending.delete(seq);
					pending.reject(
						new DapTransportError(
							"DAP_REQUEST_TIMEOUT",
							this.withStderrContext(
								`dap request '${pending.command}' timed out after ${timeoutMs}ms`,
							),
						),
					);
				}, timeoutMs);
				if (timer.unref) timer.unref();
			}
			this.pending.set(seq, { command, resolve, reject, timer });
		});
	}

	close(): void {
		if (this.closed) return;
		this.failTransport("manual_close", null, null, null);
	}

	private processBuffer(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
			const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
			if (!lengthMatch) {
				throw new DapTransportError(
					"DAP_PROTOCOL_HEADER_INVALID",
					this.withStderrContext("invalid dap header: missing Content-Length"),
				);
			}
			const contentLength = Number.parseInt(lengthMatch[1], 10);
			if (!Number.isFinite(contentLength) || contentLength < 0) {
				throw new DapTransportError(
					"DAP_PROTOCOL_HEADER_INVALID",
					this.withStderrContext("invalid dap header: bad Content-Length"),
				);
			}
			const messageStart = headerEnd + 4;
			const messageEnd = messageStart + contentLength;
			if (this.buffer.length < messageEnd) return;

			const payload = this.buffer
				.subarray(messageStart, messageEnd)
				.toString("utf8");
			this.buffer = this.buffer.subarray(messageEnd);
			this.handleMessage(payload);
		}
	}

	private handleMessage(payload: string): void {
		let message: DebugProtocol.Response | DebugProtocol.Event;
		try {
			message = JSON.parse(payload) as
				| DebugProtocol.Response
				| DebugProtocol.Event;
		} catch {
			throw new DapTransportError(
				"DAP_PROTOCOL_JSON_INVALID",
				this.withStderrContext("invalid dap payload: JSON parse failed"),
			);
		}
		if (message.type === "response") {
			this.handleResponse(message as DebugProtocol.Response);
			return;
		}
		if (message.type === "event") {
			const eventMessage = message as DebugProtocol.Event;
			for (const handler of this.eventHandlers.get(eventMessage.event) ?? []) {
				handler(eventMessage);
			}
		}
	}

	private handleResponse(response: DebugProtocol.Response): void {
		const pending = this.pending.get(response.request_seq);
		if (pending) {
			this.pending.delete(response.request_seq);
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
			if (response.success) {
				pending.resolve(response.body ?? {});
			} else {
				pending.reject(
					new DapTransportError(
						"DAP_REQUEST_FAILED",
						this.withStderrContext(response.message ?? "dap request failed"),
					),
				);
			}
		}
		for (const handler of this.responseHandlers.get(response.command) ?? []) {
			handler(response);
		}
	}

	private writeMessage(message: DebugProtocol.Request): void {
		const payload = Buffer.from(JSON.stringify(message), "utf8");
		const header = Buffer.from(
			`Content-Length: ${payload.length}\r\n\r\n`,
			"utf8",
		);
		const ok = this.child.stdin.write(Buffer.concat([header, payload]));
		if (!ok) {
			// Let backpressure drain naturally; if the process closes we will fail pending.
		}
	}

	private withStderrContext(message: string): string {
		const tail = this.stderrTail.trim();
		if (!tail) return message;
		return `${message} (stderr: ${tail})`;
	}

	private failTransport(
		reason: DapTransportCloseEvent["reason"],
		error: DapTransportError | null,
		exitCode: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (this.closed) return;
		this.closed = true;

		for (const [, pending] of this.pending) {
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
			pending.reject(
				error ??
					new DapTransportError(
						"DAP_TRANSPORT_CLOSED",
						this.withStderrContext("dap transport is closed"),
					),
			);
		}
		this.pending.clear();

		if (reason === "manual_close") {
			try {
				this.child.kill("SIGTERM");
			} catch {
				// ignore
			}
			const killTimer = setTimeout(() => {
				// If the adapter is still running, force kill to avoid orphaned lldb-dap.
				if (this.child.exitCode !== null) return;
				try {
					this.child.kill("SIGKILL");
				} catch {
					// ignore
				}
			}, 1500);
			if (killTimer.unref) killTimer.unref();
		}

		const closeEvent: DapTransportCloseEvent = {
			reason,
			error,
			exitCode,
			signal,
			stderr: this.stderrTail.trim(),
		};
		for (const handler of this.closeHandlers) {
			handler(closeEvent);
		}
	}
}

function asTransportError(
	error: unknown,
	code: DapTransportErrorCode,
	fallbackMessage: string,
): DapTransportError {
	if (error instanceof DapTransportError) return error;
	if (error instanceof Error) {
		return new DapTransportError(code, error.message || fallbackMessage);
	}
	return new DapTransportError(code, fallbackMessage);
}
