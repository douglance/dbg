import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { DapTransport } from "../packages/adapter-dap/src/transport.js";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

function createFakeChild(): ChildProcessWithoutNullStreams {
	const child = new EventEmitter() as ChildProcessWithoutNullStreams;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const stdin = new PassThrough();
	child.stdout = stdout;
	child.stderr = stderr;
	child.stdin = stdin;
	child.kill = vi.fn(
		() => true,
	) as unknown as ChildProcessWithoutNullStreams["kill"];
	return child;
}

describe("dap transport", () => {
	it("times out requests with a typed transport error", async () => {
		const child = createFakeChild();
		const transport = new DapTransport(child);

		await expect(
			transport.request("threads", undefined, { timeoutMs: 10 }),
		).rejects.toMatchObject({
			name: "DapTransportError",
			code: "DAP_REQUEST_TIMEOUT",
		});

		transport.close();
	});

	it("rejects pending requests when process exits and carries stderr context", async () => {
		const child = createFakeChild();
		const transport = new DapTransport(child);

		const pending = transport.request("threads");
		(child.stderr as PassThrough).write("process boom");
		child.emit("exit", 1, null);

		await expect(pending).rejects.toMatchObject({
			name: "DapTransportError",
			code: "DAP_PROCESS_EXITED",
		});
		await expect(pending).rejects.toThrow("process boom");
	});

	it("fails pending requests on invalid dap header", async () => {
		const child = createFakeChild();
		const transport = new DapTransport(child);

		const pending = transport.request("threads");
		(child.stdout as PassThrough).write(
			Buffer.from("Content-Length: abc\r\n\r\n{}", "utf8"),
		);

		await expect(pending).rejects.toMatchObject({
			name: "DapTransportError",
			code: "DAP_PROTOCOL_HEADER_INVALID",
		});
	});
});
