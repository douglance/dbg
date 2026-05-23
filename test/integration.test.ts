import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-test.sock";
const DEFAULT_SOCKET_PATH = "/tmp/dbg.sock";
const TARGET = path.resolve(__dirname, "fixtures/target.js");
const EVENTS_DB_PATH = path.resolve(__dirname, ".tmp-events.db");

// ─── Helpers ───

function dbg(...args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 15000,
			env: {
				...process.env,
				DBG_SOCK: SOCKET_PATH,
				DBG_EVENTS_DB: EVENTS_DB_PATH,
			},
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: err.status ?? 1,
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

function fallbackPathsForCwd(cwd: string): {
	socket: string;
	eventsDb: string;
} {
	const uid =
		typeof process.getuid === "function" ? String(process.getuid()) : "0";
	const repoHash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
	return {
		socket: `/tmp/dbg-${uid}-${repoHash}.sock`,
		eventsDb: `/tmp/dbg-${uid}-${repoHash}-events.db`,
	};
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
					env: {
						...process.env,
						DBG_SOCK: SOCKET_PATH,
						DBG_EVENTS_DB: EVENTS_DB_PATH,
					},
				});
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}

	// Kill any lingering daemon processes (find via socket)
	try {
		const pids = execFileSync("lsof", ["-t", SOCKET_PATH], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		for (const pid of pids.split("\n").filter(Boolean)) {
			try {
				process.kill(Number.parseInt(pid, 10), "SIGTERM");
			} catch {
				// already dead
			}
		}
	} catch {
		// no process on socket
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
	let targetProcess2: ChildProcess | null = null;

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

		// Kill targets if we spawned them
		if (targetProcess && !targetProcess.killed) {
			targetProcess.kill("SIGKILL");
			targetProcess = null;
		}
		if (targetProcess2 && !targetProcess2.killed) {
			targetProcess2.kill("SIGKILL");
			targetProcess2 = null;
		}

		// Kill daemon between tests
		killDaemon();

		// Small delay so sockets release
		await sleep(200);

		// Remove event store db and WAL files between tests
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				fs.unlinkSync(EVENTS_DB_PATH + suffix);
			} catch {
				// ignore
			}
		}
	});

	afterAll(() => {
		killDaemon();
	});

	/** Spawn a target with --inspect-brk and wait for the debugger to be ready. */
	async function spawnTarget(): Promise<number> {
		inspectPort = await findFreePort();
		targetProcess = spawn(
			process.execPath,
			[`--inspect-brk=${inspectPort}`, TARGET],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		// Wait for "Debugger listening" on stderr
		return new Promise((resolve, reject) => {
			let stderr = "";
			const timeout = setTimeout(
				() => reject(new Error("target did not start")),
				10000,
			);
			const child = targetProcess;

			if (!child?.stderr) {
				clearTimeout(timeout);
				reject(new Error("target process stderr is unavailable"));
				return;
			}

			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				const match = stderr.match(
					/Debugger listening on ws:\/\/[\w.]+:(\d+)\//,
				);
				if (match) {
					clearTimeout(timeout);
					resolve(Number.parseInt(match[1], 10));
				}
			});

			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	/** Spawn an independent target, returning its process and port (no side effects). */
	async function spawnNewTarget(): Promise<{
		proc: ChildProcess;
		port: number;
	}> {
		const port = await findFreePort();
		const proc = spawn(process.execPath, [`--inspect-brk=${port}`, TARGET], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		return new Promise((resolve, reject) => {
			let stderr = "";
			const timeout = setTimeout(
				() => reject(new Error("target did not start")),
				10000,
			);

			if (!proc?.stderr) {
				clearTimeout(timeout);
				reject(new Error("target process stderr is unavailable"));
				return;
			}

			proc.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				const match = stderr.match(
					/Debugger listening on ws:\/\/[\w.]+:(\d+)\//,
				);
				if (match) {
					clearTimeout(timeout);
					resolve({ proc, port: Number.parseInt(match[1], 10) });
				}
			});

			proc.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	// ─── 0. Custom socket path ───

	it("uses DBG_SOCK env var for custom socket path", async () => {
		const customSocket = "/tmp/dbg-test-custom.sock";
		// Clean up any stale socket
		try {
			fs.unlinkSync(customSocket);
		} catch {
			// ignore
		}

		try {
			const r = execFileSync(process.execPath, [CLI, "status"], {
				encoding: "utf8",
				timeout: 15000,
				env: {
					...process.env,
					DBG_SOCK: customSocket,
					DBG_EVENTS_DB: EVENTS_DB_PATH,
				},
			});
			expect(fs.existsSync(customSocket)).toBe(true);
			expect(r).toContain("connected: false");
		} finally {
			// Kill daemon on custom socket
			try {
				const pids = execFileSync("lsof", ["-t", customSocket], {
					encoding: "utf8",
					timeout: 3000,
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				for (const pid of pids.split("\n").filter(Boolean)) {
					try {
						process.kill(Number.parseInt(pid, 10), "SIGTERM");
					} catch {
						// already dead
					}
				}
			} catch {
				// no process on socket
			}
			try {
				fs.unlinkSync(customSocket);
			} catch {
				// ignore
			}
		}
	});

	it("falls back to deterministic per-repo socket/db when default socket is unhealthy", async () => {
		if (fs.existsSync(DEFAULT_SOCKET_PATH)) {
			// Respect existing local daemon/socket and avoid mutating user state.
			return;
		}

		const fakeServer = net.createServer((socket) => {
			// The CLI may close the connection before we finish writing,
			// which surfaces as EPIPE. Swallow it — the test's purpose is
			// to confirm the CLI falls back to a deterministic socket.
			socket.on("error", () => {});
			socket.write("not-json\n");
			socket.end();
		});
		await new Promise<void>((resolve, reject) => {
			fakeServer.once("error", reject);
			fakeServer.listen(DEFAULT_SOCKET_PATH, resolve);
		});

		const fallback = fallbackPathsForCwd(process.cwd());

		try {
			const statusRun = await new Promise<{
				stdout: string;
				stderr: string;
				exitCode: number;
			}>((resolve, reject) => {
				const proc = spawn(process.execPath, [CLI, "status"], {
					env: {
						...process.env,
						DBG_SOCK: "",
						DBG_EVENTS_DB: "",
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				const timeout = setTimeout(() => {
					proc.kill("SIGKILL");
					reject(new Error("status command timed out"));
				}, 15000);
				proc.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				proc.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				proc.once("error", (err) => {
					clearTimeout(timeout);
					reject(err);
				});
				proc.once("close", (code) => {
					clearTimeout(timeout);
					resolve({
						stdout,
						stderr,
						exitCode: code ?? 1,
					});
				});
			});
			expect(statusRun.exitCode).toBe(0);
			expect(statusRun.stderr).toBe("");
			expect(statusRun.stdout).toContain("connected: false");
			expect(fs.existsSync(fallback.socket)).toBe(true);
		} finally {
			fakeServer.close();
			try {
				fs.unlinkSync(DEFAULT_SOCKET_PATH);
			} catch {
				// ignore
			}
			try {
				execFileSync(process.execPath, [CLI, "close"], {
					encoding: "utf8",
					timeout: 5000,
					env: {
						...process.env,
						DBG_SOCK: fallback.socket,
						DBG_EVENTS_DB: fallback.eventsDb,
					},
				});
			} catch {
				// ignore
			}
			for (const suffix of ["", "-wal", "-shm"]) {
				try {
					fs.unlinkSync(fallback.eventsDb + suffix);
				} catch {
					// ignore
				}
			}
		}
	});

	// ─── 1. Daemon lifecycle ───

	it("starts daemon, verifies socket exists, stops via close", async () => {
		// Run status to auto-start daemon
		const r = dbg("status");
		// Daemon should have started and socket should exist
		expect(fs.existsSync(SOCKET_PATH)).toBe(true);
		expect(r.exitCode).toBe(0);
		// Status should show disconnected since we haven't opened anything
		expect(r.stdout).toContain("connected: false");
	});

	it("runs query against event store without an active session", () => {
		const q = dbg(
			"q",
			"SELECT method FROM events ORDER BY id DESC LIMIT 5",
			"--json",
		);
		expect(q.exitCode).toBe(0);
		const parsed = JSON.parse(q.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.columns).toEqual(["method"]);
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

		const evalResult = dbg("e", "process.pid", "--json");
		expect(evalResult.exitCode).toBe(0);
		const parsed = JSON.parse(evalResult.stdout);
		expect(parsed.ok).toBe(true);
		const pid = Number.parseInt(String(parsed.value), 10);
		expect(pid).toBeGreaterThan(0);
	});

	// ─── 6. Eval expression ───

	it("evaluates arithmetic expression", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		const evalResult = dbg("e", "1 + 2", "--json");
		expect(evalResult.exitCode).toBe(0);
		const parsed = JSON.parse(evalResult.stdout);
		expect(parsed.ok).toBe(true);
		expect(String(parsed.value)).toBe("3");
	});

	// ─── 7. Breakpoint list ───

	it("lists breakpoints after setting one", async () => {
		const port = await spawnTarget();

		dbg("open", String(port));

		dbg("b", "target.js:6");

		const blResult = dbg("bl", "--json");
		expect(blResult.exitCode).toBe(0);
		const parsed = JSON.parse(blResult.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.columns).toEqual(["id", "file", "line", "condition", "hits"]);
		// At least one row referencing target.js
		const hasTarget = (parsed.rows as unknown[][]).some((row) =>
			String(row[1] ?? "").includes("target.js"),
		);
		expect(hasTarget).toBe(true);
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
		expect(status.stdout).toMatch(/pid:\s*\d+/);
	});

	it("shows recent CDP trace events", async () => {
		const port = await spawnTarget();
		dbg("open", String(port));

		const stepResult = dbg("n");
		expect(stepResult.exitCode).toBe(0);

		const trace = dbg("trace", "20", "--json");
		expect(trace.exitCode).toBe(0);
		const parsed = JSON.parse(trace.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.columns).toEqual([
			"id",
			"ts",
			"direction",
			"method",
			"latency_ms",
			"error",
			"data",
		]);
		const hasStepOver = (parsed.rows as unknown[][]).some((row) =>
			String(row[3] ?? "").includes("Debugger.stepOver"),
		);
		expect(hasStepOver).toBe(true);
	});

	it("reports health and latency", async () => {
		const port = await spawnTarget();
		dbg("open", String(port));

		const health = dbg("health", "--json");
		expect(health.exitCode).toBe(0);
		const parsed = JSON.parse(health.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.messages?.[0] ?? "").toMatch(/^healthy \(\d+ms\)$/);
	});

	it("health fails when disconnected", () => {
		const health = dbg("health");
		expect(health.exitCode).toBe(1);
		// incur emits errors on stdout in the default TOON format.
		expect(`${health.stdout}${health.stderr}`).toContain("not connected");
	});

	it("queries event store virtual tables", async () => {
		const port = await spawnTarget();
		dbg("open", String(port));
		dbg("n");

		const events = dbg(
			"q",
			"SELECT source, category, method FROM events LIMIT 5",
			"--json",
		);
		expect(events.exitCode).toBe(0);
		const eventsParsed = JSON.parse(events.stdout);
		expect(eventsParsed.ok).toBe(true);
		expect(eventsParsed.columns).toEqual(["source", "category", "method"]);

		const cdp = dbg("q", "SELECT method, direction FROM cdp LIMIT 5", "--json");
		expect(cdp.exitCode).toBe(0);
		const cdpParsed = JSON.parse(cdp.stdout);
		expect(cdpParsed.ok).toBe(true);
		expect(cdpParsed.columns).toEqual(["method", "direction"]);
	});

	// ─── Multi-session tests ───

	describe("multi-session", () => {
		it("opens two sessions with names and lists them", async () => {
			const t1 = await spawnNewTarget();
			const t2 = await spawnNewTarget();
			targetProcess = t1.proc;
			targetProcess2 = t2.proc;

			const open1 = dbg("open", String(t1.port), "a");
			expect(open1.exitCode).toBe(0);
			expect(open1.stdout).toContain("connected");

			const open2 = dbg("open", String(t2.port), "b");
			expect(open2.exitCode).toBe(0);
			expect(open2.stdout).toContain("connected");

			const ss = dbg("ss", "--json");
			expect(ss.exitCode).toBe(0);
			const parsed = JSON.parse(ss.stdout);
			expect(parsed.ok).toBe(true);
			const names = (parsed.sessions as Array<{ name: string }>).map(
				(s) => s.name,
			);
			expect(names).toContain("a");
			expect(names).toContain("b");

			dbg("close", "--session", "a");
			dbg("close", "--session", "b");
		});

		it("'use' switches current session", async () => {
			const t1 = await spawnNewTarget();
			const t2 = await spawnNewTarget();
			targetProcess = t1.proc;
			targetProcess2 = t2.proc;

			dbg("open", String(t1.port), "a");
			dbg("open", String(t2.port), "b");

			const useA = dbg("use", "a");
			expect(useA.exitCode).toBe(0);

			const statusA = dbg("status");
			expect(statusA.exitCode).toBe(0);
			expect(statusA.stdout).toContain("connected");

			const useB = dbg("use", "b");
			expect(useB.exitCode).toBe(0);

			const statusB = dbg("status");
			expect(statusB.exitCode).toBe(0);
			expect(statusB.stdout).toContain("connected");

			dbg("close", "--session", "a");
			dbg("close", "--session", "b");
		});

		it("--session flag targets specific session", async () => {
			const t1 = await spawnNewTarget();
			const t2 = await spawnNewTarget();
			targetProcess = t1.proc;
			targetProcess2 = t2.proc;

			dbg("open", String(t1.port), "a");
			dbg("open", String(t2.port), "b");

			const statusA = dbg("status", "--session", "a");
			expect(statusA.exitCode).toBe(0);
			expect(statusA.stdout).toContain("connected");

			const statusB = dbg("status", "--session", "b");
			expect(statusB.exitCode).toBe(0);
			expect(statusB.stdout).toContain("connected");

			const stepA = dbg("n", "--session", "a");
			expect(stepA.exitCode).toBe(0);
			expect(stepA.stdout).toContain("paused");

			const stepB = dbg("n", "--session", "b");
			expect(stepB.exitCode).toBe(0);
			expect(stepB.stdout).toContain("paused");

			dbg("close", "--session", "a");
			dbg("close", "--session", "b");
		});

		it("close one session leaves other intact", async () => {
			const t1 = await spawnNewTarget();
			const t2 = await spawnNewTarget();
			targetProcess = t1.proc;
			targetProcess2 = t2.proc;

			dbg("open", String(t1.port), "a");
			dbg("open", String(t2.port), "b");

			dbg("close", "--session", "a");

			const ss = dbg("ss", "--json");
			expect(ss.exitCode).toBe(0);
			const parsed = JSON.parse(ss.stdout);
			const names = (parsed.sessions as Array<{ name: string }>).map(
				(s) => s.name,
			);
			expect(names).toContain("b");
			expect(names).not.toContain("a");

			// Single remaining session auto-resolves without --session
			const status = dbg("status");
			expect(status.exitCode).toBe(0);
			expect(status.stdout).toContain("connected");

			dbg("close", "--session", "b");
		});

		it("single session works without --session (backwards compat)", async () => {
			const port = await spawnTarget();

			const openResult = dbg("open", String(port), "mysession");
			expect(openResult.exitCode).toBe(0);

			// No --session needed — single session auto-resolves
			const status = dbg("status");
			expect(status.exitCode).toBe(0);
			expect(status.stdout).toContain("connected");

			const step = dbg("n");
			expect(step.exitCode).toBe(0);
			expect(step.stdout).toContain("paused");

			dbg("close");
		});

		it("query shows events from multiple sessions", async () => {
			const t1 = await spawnNewTarget();
			const t2 = await spawnNewTarget();
			targetProcess = t1.proc;
			targetProcess2 = t2.proc;

			dbg("open", String(t1.port), "a");
			dbg("open", String(t2.port), "b");

			dbg("n", "--session", "a");
			dbg("n", "--session", "b");

			const q = dbg("q", "SELECT method FROM cdp LIMIT 10", "--json");
			expect(q.exitCode).toBe(0);
			const parsed = JSON.parse(q.stdout);
			expect(parsed.ok).toBe(true);
			expect(parsed.columns).toEqual(["method"]);
			expect((parsed.rows as unknown[][]).length).toBeGreaterThan(0);

			dbg("close", "--session", "a");
			dbg("close", "--session", "b");
		});
	});
});
