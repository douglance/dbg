import { describe, expect, it, vi } from "vitest";

import type { ProviderResolutionResult } from "../packages/types/src/index.js";
import { createState } from "./helpers.js";

import {
	executeAttachWithStrategy,
	resolveStrategyOrder,
	validateStopStateHandshake,
} from "../packages/cli/src/attach-strategy.js";

function createResolution(): ProviderResolutionResult {
	return {
		provider: "apple-device",
		platform: "visionos",
		deviceId: "vision-pro-1",
		bundleId: "com.workstation.app",
		pid: 4242,
		attachProtocol: "dap",
	};
}

function createFrame() {
	return {
		callFrameId: "f-1",
		functionName: "main",
		url: "/app/main.swift",
		file: "/app/main.swift",
		line: 0,
		col: 0,
		scriptId: "s1",
		scopeChain: [],
		thisObjectId: "",
	};
}

describe("attach strategy manager", () => {
	it("resolves strategy order for auto and explicit strategies", () => {
		expect(resolveStrategyOrder("auto")).toEqual([
			"device-process",
			"gdb-remote",
		]);
		expect(resolveStrategyOrder("device-process")).toEqual(["device-process"]);
		expect(resolveStrategyOrder("gdb-remote")).toEqual(["gdb-remote"]);
		expect(resolveStrategyOrder("auto", true)).toEqual(["device-process"]);
		expect(resolveStrategyOrder("device-process", true)).toEqual([
			"device-process",
		]);
		expect(resolveStrategyOrder("gdb-remote", true)).toEqual(["gdb-remote"]);
	});

	it("falls back from device-process to gdb-remote", async () => {
		const state = createState();
		const resolution = createResolution();

		const firstClient = {
			attachLldbToPid: vi.fn(async () => {
				throw new Error("device-process failed");
			}),
			attachLldbGdbRemote: vi.fn(async () => {}),
			disconnect: vi.fn(async () => {}),
		};

		const secondClient = {
			attachLldbToPid: vi.fn(async () => {}),
			attachLldbGdbRemote: vi.fn(async () => {
				state.connected = true;
				state.paused = true;
				state.callFrames = [createFrame()];
				if (state.dap) {
					state.dap.activeThreads = [{ id: 1, name: "main" }];
				}
			}),
			disconnect: vi.fn(async () => {}),
		};

		const clients = [firstClient, secondClient];
		let index = 0;
		const discoverPort = vi.fn(() => 7777);
		const result = await executeAttachWithStrategy({
			request: {
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
				attachStrategy: "auto",
			},
			resolution,
			state,
			providerResolveMs: 25,
			discoverDebugProxyPort: discoverPort,
			createDapClient: () => clients[index++] as any,
		});

		expect(result.success).toBe(true);
		expect(result.strategy).toBe("gdb-remote");
		expect(result.diagnostics.attemptedStrategies).toHaveLength(2);
		expect(result.diagnostics.attemptedStrategies[0]).toMatchObject({
			strategy: "device-process",
			success: false,
		});
		expect(result.diagnostics.attemptedStrategies[1]).toMatchObject({
			strategy: "gdb-remote",
			success: true,
		});
		expect(result.diagnostics.totalMs).toBeGreaterThanOrEqual(25);
		expect(discoverPort).toHaveBeenCalledWith("vision-pro-1");
		expect(firstClient.disconnect).toHaveBeenCalledTimes(1);
		expect(secondClient.disconnect).not.toHaveBeenCalled();
	});

	it("fails attach when stop-state handshake is incomplete", async () => {
		const state = createState();
		const resolution = createResolution();
		const client = {
			attachLldbToPid: vi.fn(async () => {
				state.connected = true;
				state.paused = true;
				state.callFrames = [];
				if (state.dap) {
					state.dap.activeThreads = [{ id: 1, name: "main" }];
				}
			}),
			attachLldbGdbRemote: vi.fn(async () => {}),
			disconnect: vi.fn(async () => {}),
		};

		const result = await executeAttachWithStrategy({
			request: {
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
				attachStrategy: "device-process",
			},
			resolution,
			state,
			createDapClient: () => client as any,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("no call frames available");
		expect(client.disconnect).toHaveBeenCalledTimes(1);
	});

	it("uses pid attach for simulator targets in auto mode", async () => {
		const state = createState();
		const resolution = {
			...createResolution(),
			metadata: {
				attachEnvironment: "simulator",
			},
		} satisfies ProviderResolutionResult;

		const client = {
			attachLldbToPid: vi.fn(async () => {
				state.connected = true;
				state.paused = true;
				state.callFrames = [createFrame()];
				if (state.dap) {
					state.dap.activeThreads = [{ id: 1, name: "main" }];
				}
			}),
			attachLldbGdbRemote: vi.fn(async () => {}),
			disconnect: vi.fn(async () => {}),
		};

		const result = await executeAttachWithStrategy({
			request: {
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
				attachStrategy: "auto",
			},
			resolution,
			state,
			createDapClient: () => client as any,
		});

		expect(result.success).toBe(true);
		expect(result.diagnostics.attemptedStrategies).toHaveLength(1);
		expect(result.diagnostics.attemptedStrategies[0]?.strategy).toBe(
			"device-process",
		);
		expect(client.attachLldbToPid).toHaveBeenCalledWith(
			expect.objectContaining({
				pid: 4242,
				waitFor: false,
			}),
		);
		expect(client.attachLldbGdbRemote).not.toHaveBeenCalled();
	});

	it("validates stop-state handshake conditions", () => {
		const noPause = createState();
		expect(() => validateStopStateHandshake(noPause)).toThrow("not paused");

		const noThreads = createState({ paused: true });
		noThreads.callFrames = [createFrame()];
		expect(() => validateStopStateHandshake(noThreads)).toThrow(
			"no active dap threads",
		);

		const noFrames = createState({ paused: true });
		if (noFrames.dap) {
			noFrames.dap.activeThreads = [{ id: 1, name: "main" }];
		}
		expect(() => validateStopStateHandshake(noFrames)).toThrow(
			"no call frames",
		);

		const valid = createState({ paused: true });
		valid.callFrames = [createFrame()];
		if (valid.dap) {
			valid.dap.activeThreads = [{ id: 1, name: "main" }];
		}
		expect(() => validateStopStateHandshake(valid)).not.toThrow();
	});
});
