import { describe, expect, it, vi } from "vitest";

import { DapClientWrapper } from "../packages/adapter-dap/src/client.js";
import { createState } from "./helpers.js";

describe("dap gdb-remote attach", () => {
	it("sends hyphenated gdb-remote keys in attach request", async () => {
		const state = createState();
		const wrapper = new DapClientWrapper(state);
		const requestWithTimeout = vi.fn(async () => ({}));

		(wrapper as any).resetForNewSession = vi.fn();
		(wrapper as any).startTransport = vi.fn(async () => {});
		(wrapper as any).initializeSession = vi.fn(async () => {});
		(wrapper as any).requestWithTimeout = requestWithTimeout;
		(wrapper as any).waitForPaused = vi.fn(async () => {});

		await wrapper.attachLldbGdbRemote({
			gdbRemotePort: 1234,
			gdbRemoteHostname: "127.0.0.1",
			pid: 99,
		});

		expect(requestWithTimeout).toHaveBeenNthCalledWith(
			1,
			"attach",
			{
				"gdb-remote-port": 1234,
				"gdb-remote-hostname": "127.0.0.1",
				pid: 99,
				timeout: 45,
			},
			expect.any(Number),
		);
		expect(requestWithTimeout).toHaveBeenNthCalledWith(
			2,
			"configurationDone",
			undefined,
			10000,
		);
		expect(state.connected).toBe(true);
	});

	it("rejects invalid gdb-remote port", async () => {
		const state = createState();
		const wrapper = new DapClientWrapper(state);
		await expect(
			wrapper.attachLldbGdbRemote({ gdbRemotePort: 0 }),
		).rejects.toMatchObject({
			code: "DAP_INVALID_GDB_REMOTE_PORT",
		});
	});

	it("follows initialize -> attach -> configurationDone -> waitForPaused lifecycle", async () => {
		const state = createState();
		const wrapper = new DapClientWrapper(state);
		const calls: string[] = [];

		(wrapper as any).resetForNewSession = vi.fn(() => {
			calls.push("reset");
		});
		(wrapper as any).startTransport = vi.fn(async () => {
			calls.push("startTransport");
		});
		(wrapper as any).initializeSession = vi.fn(async () => {
			calls.push("initialize");
		});
		(wrapper as any).requestWithTimeout = vi.fn(async (command: string) => {
			calls.push(command);
			return {};
		});
		(wrapper as any).waitForPaused = vi.fn(async () => {
			calls.push("waitForPaused");
		});

		await wrapper.attachLldbGdbRemote({ gdbRemotePort: 7777 });

		expect(calls).toEqual([
			"reset",
			"startTransport",
			"initialize",
			"attach",
			"configurationDone",
			"waitForPaused",
		]);
	});
});
