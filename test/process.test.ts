import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual("node:child_process");
	return {
		...actual,
		spawn: mockSpawn,
	};
});

import { killTarget, spawnTarget } from "../packages/cli/src/process.js";

function createChild(): any {
	const child = new EventEmitter() as any;
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	child.killed = false;
	child.pid = 1234;
	return child;
}

describe("process helpers", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("rejects empty command strings", async () => {
		await expect(spawnTarget("   ")).rejects.toThrow("empty command");
	});

	it("injects inspect-brk=0 and strips user inspect flags", async () => {
		const child = createChild();
		mockSpawn.mockReturnValue(child);

		const pending = spawnTarget("node --inspect=9229 app.js");
		await Promise.resolve();
		child.stderr.emit(
			"data",
			Buffer.from("Debugger listening on ws://127.0.0.1:4555/abc\n"),
		);
		const result = await pending;

		// --inspect-brk=0 → Node binds a free port atomically; port comes from stderr.
		expect(mockSpawn).toHaveBeenCalledWith(
			"node",
			["--inspect-brk=0", "app.js"],
			expect.objectContaining({
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		expect(result).toEqual({ child, port: 4555 });
	});

	it("rejects when child emits spawn error", async () => {
		const child = createChild();
		mockSpawn.mockReturnValue(child);

		const pending = spawnTarget("node app.js");
		await Promise.resolve();
		child.emit("error", new Error("ENOENT"));

		await expect(pending).rejects.toThrow("failed to spawn: ENOENT");
	});

	it("sends SIGTERM then SIGKILL if process is still alive", () => {
		vi.useFakeTimers();
		const child = {
			killed: false,
			kill: vi.fn(),
		};

		killTarget(child as any);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");

		vi.advanceTimersByTime(2000);
		expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
	});

	it("does not signal an already-killed process", () => {
		const child = {
			killed: true,
			kill: vi.fn(),
		};
		killTarget(child as any);
		expect(child.kill).not.toHaveBeenCalled();
	});
});
