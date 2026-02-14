import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachRequest } from "../packages/types/src/index.js";

const {
	mockListApps,
	mockListDevices,
	mockListProcesses,
	mockLaunchProcess,
	mockGetSimulatorAppContainer,
	mockLaunchSimulatorApp,
	mockListSimulatorDevices,
	mockListSimulatorProcesses,
} = vi.hoisted(() => ({
	mockListDevices: vi.fn(),
	mockListApps: vi.fn(),
	mockListProcesses: vi.fn(),
	mockLaunchProcess: vi.fn(),
	mockListSimulatorDevices: vi.fn(),
	mockGetSimulatorAppContainer: vi.fn(),
	mockListSimulatorProcesses: vi.fn(),
	mockLaunchSimulatorApp: vi.fn(),
}));

vi.mock("../packages/provider-apple-device/src/devicectl.js", () => ({
	listDevices: mockListDevices,
	listApps: mockListApps,
	listProcesses: mockListProcesses,
	launchProcess: mockLaunchProcess,
}));
vi.mock("../packages/provider-apple-device/src/simctl.js", () => ({
	listSimulatorDevices: mockListSimulatorDevices,
	getSimulatorAppContainer: mockGetSimulatorAppContainer,
	listSimulatorProcesses: mockListSimulatorProcesses,
	launchSimulatorApp: mockLaunchSimulatorApp,
}));

import { parseAttachRequest } from "../packages/provider-apple-device/src/contracts.js";
import { AppleDeviceProviderError } from "../packages/provider-apple-device/src/errors.js";
import { resolveAppleDeviceAttachTarget } from "../packages/provider-apple-device/src/index.js";
import { resolveVisionOsAttachTarget } from "../packages/provider-apple-device/src/visionos.js";

describe("provider-apple-device", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("parses valid attach request JSON", () => {
		const request = parseAttachRequest(
			JSON.stringify({
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
				device: "00008112-001C69E11E81A01E",
			}),
		);

		expect(request).toEqual({
			provider: "apple-device",
			platform: "visionos",
			bundleId: "com.workstation.app",
			device: "00008112-001C69E11E81A01E",
			protocol: "dap",
		});
	});

	it("defaults platform to auto when omitted", () => {
		const request = parseAttachRequest(
			JSON.stringify({
				provider: "apple-device",
				bundleId: "com.workstation.app",
			}),
		);

		expect(request).toEqual({
			provider: "apple-device",
			platform: "auto",
			bundleId: "com.workstation.app",
			protocol: "dap",
		});
	});

	it("parses attach strategy and timeout fields", () => {
		const request = parseAttachRequest(
			JSON.stringify({
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
				attachStrategy: "gdb-remote",
				attachTimeoutMs: 45000,
				verbose: true,
			}),
		);

		expect(request).toEqual({
			provider: "apple-device",
			platform: "visionos",
			bundleId: "com.workstation.app",
			protocol: "dap",
			attachStrategy: "gdb-remote",
			attachTimeoutMs: 45000,
			verbose: true,
		});
	});

	it("rejects unsupported provider in attach request", () => {
		expect(() =>
			parseAttachRequest(
				JSON.stringify({
					provider: "android-adb",
					platform: "visionos",
					bundleId: "com.workstation.app",
				}),
			),
		).toThrow("unsupported provider");
	});

	if (process.platform !== "darwin") {
		it("fails gracefully on non-macOS hosts", () => {
			expect(() =>
				resolveAppleDeviceAttachTarget({
					provider: "apple-device",
					platform: "auto",
					bundleId: "com.workstation.app",
				}),
			).toThrowError(AppleDeviceProviderError);

			try {
				resolveAppleDeviceAttachTarget({
					provider: "apple-device",
					platform: "auto",
					bundleId: "com.workstation.app",
				});
			} catch (error) {
				expect((error as AppleDeviceProviderError).code).toBe(
					"invalid_request",
				);
			}
		});
		return;
	}

	it("resolves PID by app bundle path for visionOS attach", () => {
		mockListDevices.mockReturnValue([
			{
				identifier: "00008112-001C69E11E81A01E",
				hardwareProperties: { platform: "visionOS" },
				deviceProperties: { name: "Apple Vision Pro", bootState: "booted" },
			},
		]);
		mockListApps.mockReturnValue([
			{
				bundleIdentifier: "com.workstation.app",
				name: "visionPTY",
				url: "file:///private/var/containers/Bundle/Application/ABCD/visionPTY.app/",
			},
		]);
		mockListProcesses.mockReturnValue([
			{
				processIdentifier: 33897,
				executable:
					"file:///private/var/containers/Bundle/Application/ABCD/visionPTY.app/visionPTY",
			},
		]);
		mockListSimulatorDevices.mockReturnValue([]);

		const request: AttachRequest = {
			provider: "apple-device",
			platform: "visionos",
			bundleId: "com.workstation.app",
			protocol: "dap",
		};

		const result = resolveVisionOsAttachTarget(request);
		expect(result).toMatchObject({
			provider: "apple-device",
			platform: "visionos",
			deviceId: "00008112-001C69E11E81A01E",
			bundleId: "com.workstation.app",
			pid: 33897,
			attachProtocol: "dap",
		});
	});

	it("fails fast when process is not running", () => {
		mockListDevices.mockReturnValue([
			{
				identifier: "00008112-001C69E11E81A01E",
				hardwareProperties: { platform: "visionOS" },
				deviceProperties: { name: "Apple Vision Pro", bootState: "booted" },
			},
		]);
		mockListApps.mockReturnValue([
			{
				bundleIdentifier: "com.workstation.app",
				name: "visionPTY",
				url: "file:///private/var/containers/Bundle/Application/ABCD/visionPTY.app/",
			},
		]);
		mockListProcesses.mockReturnValue([]);
		mockListSimulatorDevices.mockReturnValue([]);

		expect(() =>
			resolveVisionOsAttachTarget({
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
			}),
		).toThrowError(AppleDeviceProviderError);

		try {
			resolveVisionOsAttachTarget({
				provider: "apple-device",
				platform: "visionos",
				bundleId: "com.workstation.app",
			});
		} catch (error) {
			expect((error as AppleDeviceProviderError).code).toBe(
				"process_not_running",
			);
		}
	});

	it("launches physical device app when --launch and app is not running", () => {
		mockListDevices.mockReturnValue([
			{
				identifier: "DEVICE-UUID-1",
				hardwareProperties: { platform: "iOS", udid: "DEVICE-UDID-1" },
				deviceProperties: { name: "iPhone", bootState: "booted" },
			},
		]);
		mockListApps.mockReturnValue([
			{
				bundleIdentifier: "com.workstation.app",
				name: "visionPTY",
				url: "file:///private/var/containers/Bundle/Application/ABCD/visionPTY.app/",
			},
		]);
		mockListProcesses.mockReturnValueOnce([]).mockReturnValueOnce([
			{
				processIdentifier: 4242,
				executable:
					"file:///private/var/containers/Bundle/Application/ABCD/visionPTY.app/visionPTY",
			},
		]);
		mockLaunchProcess.mockReturnValue({
			pid: 4242,
			executable:
				"file:///private/var/containers/Bundle/Application/ABCD/visionPTY.app/visionPTY",
		});
		mockListSimulatorDevices.mockReturnValue([]);

		const result = resolveAppleDeviceAttachTarget({
			provider: "apple-device",
			platform: "ios",
			bundleId: "com.workstation.app",
			launch: true,
		});

		expect(result).toMatchObject({
			provider: "apple-device",
			platform: "ios",
			deviceId: "DEVICE-UUID-1",
			bundleId: "com.workstation.app",
			pid: 4242,
			attachProtocol: "dap",
			metadata: expect.objectContaining({
				attachEnvironment: "device",
				matchedBy: "pid",
			}),
		});
	});

	it("resolves simulator target when app is running there", () => {
		mockListDevices.mockReturnValue([]);
		mockListSimulatorDevices.mockReturnValue([
			{
				identifier: "SIM-UDID-1",
				name: "iPhone 15",
				state: "booted",
				isAvailable: true,
				platform: "ios",
				runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
			},
		]);
		mockGetSimulatorAppContainer.mockReturnValue(
			"/Users/test/Library/Developer/CoreSimulator/Devices/SIM-UDID-1/data/Containers/Bundle/Application/AAA/MyApp.app",
		);
		mockListSimulatorProcesses.mockReturnValue([
			{
				pid: 9911,
				command:
					"/Users/test/Library/Developer/CoreSimulator/Devices/SIM-UDID-1/data/Containers/Bundle/Application/AAA/MyApp.app/MyApp",
			},
		]);
		mockLaunchSimulatorApp.mockReturnValue(null);

		const result = resolveAppleDeviceAttachTarget({
			provider: "apple-device",
			platform: "ios",
			bundleId: "com.my.app",
		});

		expect(result).toMatchObject({
			provider: "apple-device",
			platform: "ios",
			deviceId: "SIM-UDID-1",
			bundleId: "com.my.app",
			pid: 9911,
			attachProtocol: "dap",
			metadata: expect.objectContaining({
				attachEnvironment: "simulator",
			}),
		});
	});
});
