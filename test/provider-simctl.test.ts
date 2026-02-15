import { afterEach, describe, expect, it, vi } from "vitest";

const { mockExecFileSync } = vi.hoisted(() => ({
	mockExecFileSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual("node:child_process");
	return {
		...actual,
		execFileSync: mockExecFileSync,
	};
});

import {
	getSimulatorAppContainer,
	listSimulatorDevices,
	listSimulatorProcesses,
	parseLaunchPid,
} from "../packages/provider-apple-device/src/simctl.js";

describe("provider simctl helpers", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("lists simulator devices and maps platform from runtime", () => {
		mockExecFileSync.mockReturnValue(
			JSON.stringify({
				devices: {
					"com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
						{
							udid: "SIM-1",
							name: "iPhone 15",
							state: "Booted",
							isAvailable: true,
						},
					],
					"com.apple.CoreSimulator.SimRuntime.visionOS-2-0": [
						{
							udid: "SIM-2",
							name: "Apple Vision Pro",
							state: "Shutdown",
							isAvailable: true,
						},
					],
				},
			}),
		);

		const devices = listSimulatorDevices();
		expect(devices).toEqual([
			{
				identifier: "SIM-1",
				name: "iPhone 15",
				state: "booted",
				isAvailable: true,
				platform: "ios",
				runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
			},
			{
				identifier: "SIM-2",
				name: "Apple Vision Pro",
				state: "shutdown",
				isAvailable: true,
				platform: "visionos",
				runtime: "com.apple.CoreSimulator.SimRuntime.visionOS-2-0",
			},
		]);
	});

	it("returns null app container when app is not installed", () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("not installed");
		});
		expect(getSimulatorAppContainer("SIM-1", "com.missing.app")).toBeNull();
	});

	it("parses simulator process list", () => {
		mockExecFileSync.mockReturnValue(
			"  123 /Applications/Xcode.app\n456 /path/MyApp.app/MyApp\n",
		);
		const rows = listSimulatorProcesses("SIM-1");
		expect(rows).toEqual([
			{ pid: 123, command: "/Applications/Xcode.app" },
			{ pid: 456, command: "/path/MyApp.app/MyApp" },
		]);
	});

	it("parses launch pid from simctl output", () => {
		expect(parseLaunchPid("com.my.app: 777")).toBe(777);
		expect(parseLaunchPid("launched with pid 888")).toBe(888);
	});
});
