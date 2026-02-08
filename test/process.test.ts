import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockSpawn, mockCreateServer } = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockCreateServer: vi.fn(),
}));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual("node:child_process");
	return {
		...actual,
		spawn: mockSpawn,
	};
});

vi.mock("node:net", async () => {
	const actual = await vi.importActual("node:net");
	return {
		...actual,
		createServer: mockCreateServer,
	};
});

import { killTarget, spawnTarget } from "../src/process.js";

function setupFreePort(port: number): void {
	const server = new EventEmitter() as any;
	server.listen = vi.fn((_port: number, _host: string, cb: () => void) => cb());
	server.address = vi.fn(() => ({ port }));
	server.close = vi.fn((cb: () => void) => cb());
	server.on = vi.fn(
		(_event: string, _handler: (...args: unknown[]) => void) => server,
	);
	mockCreateServer.mockReturnValue(server);
}

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

	it("injects inspect-brk and strips user inspect flags", async () => {
		setupFreePort(4555);
		const child = createChild();
		mockSpawn.mockReturnValue(child);

		const pending = spawnTarget("node --inspect=9229 app.js");
		await Promise.resolve();
		child.stderr.emit(
			"data",
			Buffer.from("Debugger listening on ws://127.0.0.1:4555/abc\n"),
		);
		const result = await pending;

		expect(mockSpawn).toHaveBeenCalledWith(
			"node",
			["--inspect-brk=4555", "app.js"],
			expect.objectContaining({
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		expect(result).toEqual({ child, port: 4555 });
	});

	it("rejects when child emits spawn error", async () => {
		setupFreePort(4777);
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
