// Recorder integration: record.start launches managed headless Chrome via
// the daemon, captures an initial frame (PNG + frames row), and record.stop
// kills Chrome without orphans.
//
// Requires a real Chrome-compatible browser; skipped when none is installed
// (set $DBG_CHROME to point at one).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-recorder-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-recorder-"));
const EVENTS_DB_PATH = path.join(workDir, "events.db");

function dbg(...args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 60000,
			cwd: workDir,
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

function killDaemon(): void {
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
	try {
		fs.unlinkSync(SOCKET_PATH);
	} catch {
		// ignore
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(hasChrome)("recorder integration", () => {
	// The fixture server runs as a separate process: execFileSync blocks this
	// worker's event loop, so an in-process server would never answer Chrome
	// and record.start would deadlock until the CLI timeout.
	let server: ChildProcess;
	let fixtureUrl: string;

	beforeAll(async () => {
		killDaemon();
		server = spawn(
			process.execPath,
			[path.resolve(__dirname, "fixtures/http-server.js")],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const port = await new Promise<number>((resolve, reject) => {
			let buffer = "";
			server.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const line = buffer.split("\n")[0];
				if (line) resolve(Number.parseInt(line, 10));
			});
			server.on("error", reject);
			setTimeout(() => reject(new Error("fixture server timeout")), 5000);
		});
		fixtureUrl = `http://127.0.0.1:${port}/`;
	});

	afterAll(async () => {
		dbg("record", "--stop");
		killDaemon();
		server.kill("SIGKILL");
		await sleep(200);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("records a fixture page and stops without orphan Chrome", {
		timeout: 120000,
	}, async () => {
		// ── record.start ──
		const start = dbg("record", fixtureUrl, "--viewport", "800x600", "--json");
		expect(start.exitCode, start.stdout + start.stderr).toBe(0);
		const startResponse = JSON.parse(start.stdout) as {
			ok: boolean;
			recording?: {
				running: boolean;
				pid?: number;
				port?: number;
				frameCount?: number;
			};
		};
		expect(startResponse.ok).toBe(true);
		expect(startResponse.recording?.running).toBe(true);
		expect(startResponse.recording?.frameCount).toBeGreaterThanOrEqual(1);
		const chromePid = startResponse.recording?.pid;
		expect(chromePid).toBeGreaterThan(0);
		expect(isAlive(chromePid as number)).toBe(true);

		// ── session appears in dbg ss ──
		const sessions = dbg("ss", "--json");
		expect(sessions.exitCode).toBe(0);
		expect(sessions.stdout).toContain("recorder");

		// ── record.status ──
		const status = dbg("record", "--status", "--json");
		expect(status.exitCode).toBe(0);
		const statusResponse = JSON.parse(status.stdout) as {
			recording?: { running: boolean; urls?: string[]; frameCount?: number };
		};
		expect(statusResponse.recording?.running).toBe(true);
		expect(statusResponse.recording?.urls).toEqual([fixtureUrl]);
		expect(statusResponse.recording?.frameCount).toBeGreaterThanOrEqual(1);

		// ── captures row + PNG on disk with PNG magic bytes ──
		const rows = dbg("q", "SELECT png_path, url FROM captures", "--json");
		expect(rows.exitCode, rows.stdout + rows.stderr).toBe(0);
		const rowsResponse = JSON.parse(rows.stdout) as {
			rows: unknown[][];
		};
		expect(rowsResponse.rows.length).toBeGreaterThanOrEqual(1);
		const pngPath = rowsResponse.rows[0][0] as string;
		// The daemon's cwd is the realpath (macOS tmpdir is symlinked).
		expect(
			pngPath.startsWith(
				path.join(fs.realpathSync(workDir), ".dbg", "recordings"),
			),
		).toBe(true);
		const png = fs.readFileSync(pngPath);
		expect(Array.from(png.subarray(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		expect(rowsResponse.rows[0][1]).toBe(fixtureUrl);

		// ── COUNT(*) success criterion: captures returns recorder rows ──
		const count = dbg("q", "SELECT COUNT(*) FROM captures", "--json");
		expect(count.exitCode, count.stdout + count.stderr).toBe(0);
		const countResponse = JSON.parse(count.stdout) as { rows: unknown[][] };
		expect(Number(countResponse.rows[0][0])).toBeGreaterThanOrEqual(1);
		// legacy stack-frames table remains untouched
		const legacyCount = dbg("q", "SELECT COUNT(*) FROM frames", "--json");
		expect(legacyCount.exitCode, legacyCount.stdout + legacyCount.stderr).toBe(
			0,
		);

		// ── record.stop kills Chrome ──
		const stop = dbg("record", "--stop", "--json");
		expect(stop.exitCode, stop.stdout + stop.stderr).toBe(0);
		const stopResponse = JSON.parse(stop.stdout) as {
			ok: boolean;
			recording?: { running: boolean };
		};
		expect(stopResponse.ok).toBe(true);
		expect(stopResponse.recording?.running).toBe(false);

		// pid must be dead (allow the SIGTERM grace period to elapse)
		const deadline = Date.now() + 5000;
		while (isAlive(chromePid as number) && Date.now() < deadline) {
			await sleep(100);
		}
		expect(isAlive(chromePid as number)).toBe(false);

		// status reflects stopped state
		const finalStatus = dbg("record", "--status", "--json");
		const finalResponse = JSON.parse(finalStatus.stdout) as {
			recording?: { running: boolean };
		};
		expect(finalResponse.recording?.running).toBe(false);
	});
});

describe.runIf(!hasChrome)("recorder integration (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
