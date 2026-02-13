import type { DebugProtocol } from "@vscode/debugprotocol";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
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
	private seq = 1;
	private buffer = Buffer.alloc(0);
	private closed = false;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.processBuffer();
		});
		this.child.on("exit", () => {
			this.closed = true;
			for (const [, pending] of this.pending) {
				pending.reject(new Error("dap process exited"));
			}
			this.pending.clear();
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

	async request(command: string, argumentsValue?: unknown): Promise<unknown> {
		if (this.closed) {
			throw new Error("dap transport is closed");
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
			this.pending.set(seq, { resolve, reject });
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.child.kill("SIGTERM");
	}

	private processBuffer(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
			const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
			if (!lengthMatch) {
				throw new Error("invalid dap header: missing Content-Length");
			}
			const contentLength = Number.parseInt(lengthMatch[1], 10);
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
		const message = JSON.parse(payload) as
			| DebugProtocol.Response
			| DebugProtocol.Event;
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
			if (response.success) {
				pending.resolve(response.body ?? {});
			} else {
				pending.reject(new Error(response.message ?? "dap request failed"));
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
		this.child.stdin.write(Buffer.concat([header, payload]));
	}
}
