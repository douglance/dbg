// Daemon spawn race / split-brain regression tests.
//
// Root cause being guarded against: startServer used to unlink-then-listen,
// so a daemon forked while another was already serving would DELETE the
// live daemon's socket and usurp it — orphaning the previous daemon with all
// its session state (integration tests then saw session lists missing
// entries under load). The fix is atomic bind-or-defer: bind without
// unlinking; on EADDRINUSE probe the socket — a live daemon answers and the
// newcomer exits(0); only a dead socket file is taken over. The CLI client
// no longer unlinks sockets at all.
//
// No Chrome required — these tests run everywhere.

import {
	type ChildProcess,
	execFile,
	execFileSync,
	spawn,
} from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const DAEMON = path.resolve(__dirname, "../packages/cli/dist/daemon.js");

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
let socketCounter = 0;

function freshEnv(): { socketPath: string; env: NodeJS.ProcessEnv } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-race-"));
	tmpDirs.push(dir);
	const socketPath = `/tmp/dbg-race-${process.pid}-${socketCounter++}.sock`;
	return {
		socketPath,
		env: {
			...process.env,
			DBG_SOCK: socketPath,
			DBG_EVENTS_DB: path.join(dir, "events.db"),
		},
	};
}

function spawnDaemon(env: NodeJS.ProcessEnv): ChildProcess {
	const child = spawn(process.execPath, [DAEMON], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

function canConnect(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
		socket.setTimeout(1000, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function waitFor(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Ask the daemon on this socket for its status; returns the raw response. */
function socketRequest(socketPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ cmd: "record.status" })}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (buffer.includes("\n")) {
				socket.destroy();
				resolve(buffer);
			}
		});
		socket.on("error", reject);
		socket.setTimeout(3000, () => {
			socket.destroy();
			reject(new Error("socket request timeout"));
		});
	});
}

function socketOwners(socketPath: string): number[] {
	try {
		const out = execFileSync("lsof", ["-t", socketPath], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out
			.split("\n")
			.filter(Boolean)
			.map((pid) => Number.parseInt(pid, 10));
	} catch {
		return [];
	}
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already dead
		}
	}
	await new Promise((r) => setTimeout(r, 100));
	while (tmpDirs.length) {
		const dir = tmpDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("daemon bind-or-defer", () => {
	it("a daemon forked against a live socket defers and exits 0 without usurping", async () => {
		const { socketPath, env } = freshEnv();
		const winner = spawnDaemon(env);
		await waitFor(() => canConnect(socketPath), 5000, "winner socket");

		const loser = spawnDaemon(env);
		const exitCode = await new Promise<number | null>((resolve) => {
			loser.on("exit", (code) => resolve(code));
		});
		expect(exitCode, "deferring daemon must exit 0").toBe(0);

		// The winner still owns and serves the socket.
		expect(winner.exitCode).toBe(null);
		const response = await socketRequest(socketPath);
		expect(response).toContain('"ok":true');
		expect(socketOwners(socketPath)).toEqual([winner.pid]);

		winner.kill("SIGTERM");
	});

	it("takes over a stale socket file left by a SIGKILLed daemon", async () => {
		const { socketPath, env } = freshEnv();
		const first = spawnDaemon(env);
		await waitFor(() => canConnect(socketPath), 5000, "first socket");
		first.kill("SIGKILL"); // no cleanup — socket file left behind, dead
		await waitFor(
			async () => !(await canConnect(socketPath)),
			5000,
			"first daemon death",
		);
		expect(fs.existsSync(socketPath), "stale socket file remains").toBe(true);

		const second = spawnDaemon(env);
		await waitFor(() => canConnect(socketPath), 5000, "takeover socket");
		expect(second.exitCode).toBe(null);
		const response = await socketRequest(socketPath);
		expect(response).toContain('"ok":true');

		second.kill("SIGTERM");
	});

	it("N concurrent CLI invocations from a clean socket converge on exactly one daemon", async () => {
		const { socketPath, env } = freshEnv();
		const BURST = 8;

		const results = await Promise.all(
			Array.from(
				{ length: BURST },
				() =>
					new Promise<{ code: number; output: string }>((resolve) => {
						execFile(
							process.execPath,
							[CLI, "record", "--status", "--json"],
							{ env, timeout: 30000 },
							(error, stdout, stderr) => {
								resolve({
									code: error ? ((error as { code?: number }).code ?? 1) : 0,
									output: stdout + stderr,
								});
							},
						);
					}),
			),
		);
		for (const result of results) {
			expect(result.code, result.output).toBe(0);
		}

		// Give racing losers a moment to defer and exit, then assert exactly
		// one daemon owns the socket and it answers consistently.
		await new Promise((r) => setTimeout(r, 1500));
		const owners = socketOwners(socketPath);
		expect(owners.length, `socket owners: ${owners.join(", ")}`).toBe(1);
		const response = await socketRequest(socketPath);
		expect(response).toContain('"ok":true');

		try {
			process.kill(owners[0], "SIGTERM");
		} catch {
			// already gone
		}
	});
});
