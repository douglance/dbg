// Perf budgets for the debug/diff loop (enforced — architectural regressions
// fail CI). Budgets are ~3x the timings measured live on an M-series Mac to
// absorb CI variance while staying tight enough to catch real regressions:
//
//   measured:  record 1.24s · mark 0.21s · after 0.22s · timeline 0.14s
//              shoot 2.15s
//
// Measurement method: Date.now() around full CLI invocations (execFileSync of
// packages/cli/dist/cli.js) — this is the latency an agent actually
// experiences, including node startup + socket round-trip, not just the
// daemon-side handler.
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-perf-test.sock";

const BUDGET_MS = {
	recordStart: 4000, // incl. daemon spawn + Chrome launch + navigate + capture
	mark: 500,
	after: 1500, // restore + forced capture + snapshot + diff + report
	timeline: 1000,
	shoot: 5000, // throwaway Chrome launch + navigate + capture + teardown
	mutationToCapture: 1500, // 300ms in-page debounce + screenshot + insert
};

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-perf-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-perf-db-"));
const chromeProfileDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "dbg-perf-profile-"),
);
const EVENTS_DB_PATH = path.join(dbDir, "events.db");

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
				DBG_CHROME_PROFILE: chromeProfileDir,
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

/** Run a dbg command, assert success, and return elapsed wall-clock ms. */
function timed(label: string, ...args: string[]): number {
	const started = Date.now();
	const result = dbg(...args);
	const elapsed = Date.now() - started;
	expect(result.exitCode, `${label}: ${result.stdout}${result.stderr}`).toBe(0);
	return elapsed;
}

function assertBudget(label: string, elapsed: number, budget: number): void {
	expect(
		elapsed,
		`${label} took ${elapsed}ms — over the ${budget}ms budget`,
	).toBeLessThan(budget);
}

function captureCount(): number {
	const result = dbg(
		"q",
		"SELECT COUNT(*) FROM captures WHERE session_id = 'recorder'",
		"--json",
	);
	expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	return Number(
		(JSON.parse(result.stdout) as { rows: unknown[][] }).rows[0][0],
	);
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

describe.runIf(hasChrome)("perf budgets — debug/diff loop", () => {
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
		for (const dir of [workDir, dbDir, chromeProfileDir]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stays inside every budget across the full loop", {
		timeout: 120000,
	}, async () => {
		// ── record.start cold: daemon spawn + Chrome launch + capture ──
		const recordMs = timed(
			"record.start",
			"record",
			fixtureUrl,
			"--viewport",
			"800x600",
			"--json",
		);
		assertBudget("record.start (cold)", recordMs, BUDGET_MS.recordStart);
		const chromePid = (
			JSON.parse(dbg("record", "--status", "--json").stdout) as {
				recording?: { pid?: number };
			}
		).recording?.pid as number;

		// ── record.mark ──
		const markMs = timed("mark", "mark", "perf-check", "--json");
		assertBudget("record.mark", markMs, BUDGET_MS.mark);

		// ── mutation → capture latency ──
		// Clock starts when the mutating eval returns; a captures row must
		// appear within budget (in-page debounce is 300ms). Poll granularity
		// (~1 CLI call ≈ 60-100ms) is inside the budget's headroom.
		const before = captureCount();
		const mutate = dbg(
			"e",
			"document.body.append(Object.assign(document.createElement('h2'),{textContent:'perf mutation'})); 'ok'",
		);
		expect(mutate.exitCode, mutate.stdout + mutate.stderr).toBe(0);
		const mutationStarted = Date.now();
		let mutationMs = Number.POSITIVE_INFINITY;
		while (Date.now() - mutationStarted < BUDGET_MS.mutationToCapture + 2000) {
			if (captureCount() > before) {
				mutationMs = Date.now() - mutationStarted;
				break;
			}
		}
		assertBudget("mutation→capture", mutationMs, BUDGET_MS.mutationToCapture);

		// ── record.after end-to-end ──
		const afterMs = timed("after", "after", "--json");
		assertBudget("record.after", afterMs, BUDGET_MS.after);

		// ── record.timeline ──
		const timelineMs = timed("timeline", "timeline", "--json");
		assertBudget("record.timeline", timelineMs, BUDGET_MS.timeline);

		// ── record.shoot (throwaway Chrome) ──
		const shootMs = timed(
			"shoot",
			"shoot",
			fixtureUrl,
			"--name",
			"perfshot",
			"--json",
		);
		assertBudget("record.shoot", shootMs, BUDGET_MS.shoot);

		// Surface the measured numbers in the test output.
		console.info(
			`perf: record=${recordMs}ms mark=${markMs}ms mutation→capture=${mutationMs}ms after=${afterMs}ms timeline=${timelineMs}ms shoot=${shootMs}ms`,
		);

		// ── stop; no orphan Chrome ──
		const stop = dbg("record", "--stop", "--json");
		expect(stop.exitCode, stop.stdout + stop.stderr).toBe(0);
		const deadline = Date.now() + 5000;
		while (isAlive(chromePid) && Date.now() < deadline) {
			await sleep(100);
		}
		expect(isAlive(chromePid)).toBe(false);
	});
});

describe.runIf(!hasChrome)("perf budgets (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
