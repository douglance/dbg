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

import { discoverDebugProxyPort } from "../packages/provider-apple-device/src/devicectl.js";

describe("discoverDebugProxyPort", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("parses debugproxy port from recent system logs", () => {
		mockExecFileSync.mockReturnValue(
			[
				"2026-02-12 CoreDevice: setup tunnel for 00008112-001C69E11E81A01E",
				"2026-02-12 debugproxy listening on tcp:62078 for device 00008112-001C69E11E81A01E",
			].join("\n"),
		);

		const port = discoverDebugProxyPort("00008112-001C69E11E81A01E");
		expect(port).toBe(62078);
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"log",
			expect.arrayContaining([
				"show",
				"--style",
				"compact",
				"--last",
				"15m",
				"--predicate",
			]),
			expect.objectContaining({ encoding: "utf8" }),
		);
	});

	it("throws actionable error when no debugproxy port is present", () => {
		mockExecFileSync.mockReturnValue(
			"2026-02-12 CoreDevice: tunnel active without debugproxy message",
		);

		expect(() => discoverDebugProxyPort("vision-device")).toThrow(
			"CoreDevice debugproxy",
		);
	});
});
