import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

const CLI = path.resolve(__dirname, "../dist/cli.js");
const DAEMON = path.resolve(__dirname, "../dist/daemon.js");
const SOCKET_PATH = "/tmp/dbg.sock";
const TARGET = path.resolve(__dirname, "fixtures/target.js");

// ─── Helpers ───

function dbg(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 15000,
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (e: any) {
		return {
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			exitCode: e.status ?? 1,
		};
	}
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address() as net.AddressInfo;
			const port = addr.port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function killDaemon(): void {
	try {
		// Try to read daemon PID from socket and kill
		if (fs.existsSync(SOCKET_PATH)) {
			// Send close command
			try {
				execFileSync(process.execPath, [CLI, "close"], {
					encoding: "utf8",
					timeout: 5000,
				});
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
	// Remove stale socket
	try {
		fs.unlinkSync(SOCKET_PATH);
	} catch {
		// ignore
	}
}

function killProcessOnPort(port: number): void {
	try {
		// macOS: find and kill process on port
		const result = execFileSync("lsof", ["-ti", `tcp:${port}`], {
			encoding: "utf8",
			timeout: 3000,
		}).trim();
		if (result) {
			for (const pid of result.split("\n")) {
				try {
					process.kill(Number.parseInt(pid, 10), "SIGKILL");
				} catch {
					// already dead
				}
			}
		}
	} catch {
		// no process on port
	}
}

// ─── Test suite ───

describe("integration", () => {
	let targetProcess: ChildProcess | null = null;
	let inspectPort: number;

	beforeAll(() => {
		// Ensure no stale daemon
		killDaemon();
	});

	afterEach(async () => {
		// Close any open connection
		try {
			dbg("close");
		} catch {
			// ignore
		}

		// Kill target if we spawned one
		if (targetProcess && !targetProcess.killed) {
			targetProcess.kill("SIGKILL");
			targetProcess = null;
		}

		// Kill daemon between tests
		killDaemon();

		// Small delay so sockets release
		await sleep(200);
	});

	afterAll(() => {
		killDaemon();
	});

	/** Spawn a target with --inspect-brk and wait for the debugger to be ready. */
	async function spawnTarget(): Promise<number> {
		inspectPort = await findFreePort();
		targetProcess = spawn(process.execPath, [`--inspect-brk=${inspectPort}`, TARGET], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Wait for "Debugger listening" on stderr
		return new Promise((resolve, reject) => {
			let stderr = "";
			const timeout = setTimeout(() => reject(new Error("target did not start")), 10000);

			targetProcess!.stderr!.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				const match = stderr.match(/Debugger listening on ws:\/\/[\w.]+:(\d+)\//);
				if (match) {
					clearTimeout(timeout);
					resolve(Number.parseInt(match[1], 10));
				}
			});

			targetProcess!.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	// ─── 1. Daemon lifecycle ───

	it("starts daemon, verifies socket exists, stops via close", async () => {
		// Run status to auto-start daemon
		const r = dbg("status");
		// Daemon should have started and socket should exist
		expect(fs.existsSync(SOCKET_PATH)).toBe(true);
		expect(r.exitCode).toBe(0);
		// Status should show disconnected since we haven't opened anything
		expect(r.stdout).toContain("disconnected");
	});

	// ─── 2. Open + Status + Close ───

	it("opens a connection, checks status, and closes", async () => {
		const port = await spawnTarget();

		const openResult = dbg("open", String(port));
		expect(openResult.exitCode).toBe(0);
		expect(openResult.stdout).toContain("connected");

		const statusResult = dbg("status");
		expect(statusResult.exitCode).toBe(0);
		expect(statusResult.stdout).toContain("connected");
		expect(statusResult.stdout).toContain("paused");

		const closeResult = dbg("close");
		expect(closeResult.exitCode).toBe(0);
	});

	// ─── 3. Stepping ───

	it("steps over and verifies location changes", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		const status1 = dbg("status");
		expect(status1.stdout).toContain("paused");

		// Step over -- should move to next line
		const step1 = dbg("n");
		expect(step1.exitCode).toBe(0);
		expect(step1.stdout).toContain("paused");

		const step2 = dbg("n");
		expect(step2.exitCode).toBe(0);
		expect(step2.stdout).toContain("paused");

		// The line should have changed between steps
		// Extract lines from status output
		const line1 = step1.stdout.trim();
		const line2 = step2.stdout.trim();
		// They should not be identical since we stepped
		expect(line1).not.toBe(line2);
	});

	// ─── 4. Breakpoints ───

	it("sets breakpoint, continues, and hits it", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		// Set breakpoint on line 14 (const result = greet("world"))
		const bResult = dbg("b", "target.js:14");
		expect(bResult.exitCode).toBe(0);
		expect(bResult.stdout).toContain("target.js");

		// Continue -- should hit the breakpoint
		const cResult = dbg("c");
		expect(cResult.exitCode).toBe(0);
		expect(cResult.stdout).toContain("paused");
		// Should be at or near line 14
		expect(cResult.stdout).toMatch(/14|target\.js/);
	});

	// ─── 5. Eval ───

	it("evaluates process.pid and gets a number", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		const evalResult = dbg("e", "process.pid");
		expect(evalResult.exitCode).toBe(0);
		const pid = Number.parseInt(evalResult.stdout.trim(), 10);
		expect(pid).toBeGreaterThan(0);
	});

	// ─── 6. Eval expression ───

	it("evaluates arithmetic expression", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		const evalResult = dbg("e", "1 + 2");
		expect(evalResult.exitCode).toBe(0);
		expect(evalResult.stdout.trim()).toBe("3");
	});

	// ─── 7. Breakpoint list ───

	it("lists breakpoints after setting one", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		dbg("b", "target.js:6");

		const blResult = dbg("bl");
		expect(blResult.exitCode).toBe(0);
		// Should have the header and at least one row
		expect(blResult.stdout).toContain("id\tfile\tline\tcondition\thits");
		expect(blResult.stdout).toContain("target.js");
	});

	// ─── 8. Run command ───

	it("uses run to spawn and connect to a target", async () => {
		const runResult = dbg("run", `node ${TARGET}`);
		expect(runResult.exitCode).toBe(0);
		expect(runResult.stdout).toContain("spawned");
		expect(runResult.stdout).toContain("connected");

		const status = dbg("status");
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain("connected");
		expect(status.stdout).toContain("paused");
		expect(status.stdout).toContain("pid=");
	});
});
