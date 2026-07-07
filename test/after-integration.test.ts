// Phase 3 e2e: record → mark → mutate (color + console.error) → dbg after
// asserts diffPercent>0 and exactly one new console error; report.html is
// self-contained (base64 PNGs, wipe slider, errors panel); dbg timeline
// renders the filmstrip; dbg replay restores a capture; diffs row inserted.
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
const SOCKET_PATH = "/tmp/dbg-after-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

// Events DB outside the watched cwd (WAL writes would pollute FS events).
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-after-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-after-db-"));
const EVENTS_DB_PATH = path.join(dbDir, "events.db");
// Own Chrome profile: vitest parallelizes test files, and the default shared
// profile's SingletonLock rejects a second concurrent Chrome.
const chromeProfileDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "dbg-after-profile-"),
);

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

describe.runIf(hasChrome)("dbg after + timeline + replay (e2e)", () => {
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
		fs.rmSync(dbDir, { recursive: true, force: true });
		fs.rmSync(chromeProfileDir, { recursive: true, force: true });
	});

	it(
		"diffs vs the mark anchor with console delta and report artifacts",
		{ timeout: 120000 },
		async () => {
			// ── record + settle ──
			const start = dbg("record", fixtureUrl, "--viewport", "800x600", "--json");
			expect(start.exitCode, start.stdout + start.stderr).toBe(0);
			const chromePid = (
				JSON.parse(start.stdout) as { recording?: { pid?: number } }
			).recording?.pid as number;
			expect(chromePid).toBeGreaterThan(0);
			await sleep(1500);

			// ── mark, then mutate: color change + one console.error ──
			const mark = dbg("mark", "before-change", "--json");
			expect(mark.exitCode, mark.stdout + mark.stderr).toBe(0);
			await sleep(100);
			const mutate = dbg(
				"e",
				"document.body.style.background='#c1121f'; console.error('boom from after test'); 'ok'",
			);
			expect(mutate.exitCode, mutate.stdout + mutate.stderr).toBe(0);
			await sleep(2500); // debounced mutation capture lands

			// ── dbg after --json ──
			const after = dbg("after", "--json");
			expect(after.exitCode, after.stdout + after.stderr).toBe(0);
			const response = JSON.parse(after.stdout) as {
				ok: boolean;
				pair?: {
					name: string;
					baseline: { captureId: number; ts: number };
					after: { captureId: number; ts: number };
					diffPercent: number;
					diffPixels: number;
					dimensionsChanged: boolean;
					clusters: number;
				};
				consoleDelta?: { new: Array<{ type: string; text: string }> };
				exceptionDelta?: { new: unknown[] };
				networkDelta?: { failed: unknown[] };
				reportPath?: string;
			};
			expect(response.ok, after.stdout).toBe(true);
			const pair = response.pair;
			expect(pair).toBeDefined();
			if (!pair || !response.consoleDelta || !response.reportPath) {
				throw new Error("unreachable");
			}

			// pixels changed (full-bleed background color change)
			expect(pair.diffPercent).toBeGreaterThan(0);
			expect(pair.diffPixels).toBeGreaterThan(0);
			expect(pair.clusters).toBeGreaterThan(0);
			expect(pair.dimensionsChanged).toBe(false);
			expect(pair.after.captureId).toBeGreaterThan(pair.baseline.captureId);
			expect(pair.after.ts).toBeGreaterThan(pair.baseline.ts);

			// ≥1 new console error mentioning the injected text (deduped across
			// Chrome's Runtime + Log double-reporting: exactly one here)
			expect(response.consoleDelta.new.length).toBe(1);
			expect(response.consoleDelta.new[0].text).toContain(
				"boom from after test",
			);

			// ── report.html: ≥3 base64 PNGs (before/after/diff) + slider + errors ──
			const html = fs.readFileSync(response.reportPath, "utf8");
			const pngCount = html.split("data:image/png;base64,").length - 1;
			expect(pngCount).toBeGreaterThanOrEqual(3);
			expect(html).toContain("wipe-range");
			expect(html).toContain("New errors");
			expect(html).toContain("boom from after test");
			// diff PNG artifact next to the captures, with PNG magic
			const recordingDir = path.join(
				fs.realpathSync(workDir),
				".dbg",
				"recordings",
				"recorder",
			);
			const diffPngName = fs
				.readdirSync(recordingDir)
				.find((f) => f.startsWith("diff-"));
			expect(diffPngName).toBeDefined();
			const diffPng = fs.readFileSync(
				path.join(recordingDir, diffPngName as string),
			);
			expect(Array.from(diffPng.subarray(0, 4))).toEqual([
				0x89, 0x50, 0x4e, 0x47,
			]);

			// ── diffs table row queryable via dbg q ──
			const diffCount = dbg("q", "SELECT COUNT(*) FROM diffs", "--json");
			expect(diffCount.exitCode, diffCount.stdout + diffCount.stderr).toBe(0);
			expect(
				Number(
					(JSON.parse(diffCount.stdout) as { rows: unknown[][] }).rows[0][0],
				),
			).toBeGreaterThanOrEqual(1);
			const diffs = dbg(
				"q",
				"SELECT name, baseline_capture_id, after_capture_id, diff_percent, report_path FROM diffs",
				"--json",
			);
			expect(diffs.exitCode, diffs.stdout + diffs.stderr).toBe(0);
			const diffRows = (JSON.parse(diffs.stdout) as { rows: unknown[][] })
				.rows;
			expect(diffRows.length).toBeGreaterThanOrEqual(1);
			expect(Number(diffRows[0][3])).toBeGreaterThan(0);

			// ── dbg timeline ──
			const timeline = dbg("timeline", "--json");
			expect(timeline.exitCode, timeline.stdout + timeline.stderr).toBe(0);
			const timelinePath = path.join(
				fs.realpathSync(workDir),
				".dbg",
				"recordings",
				"timeline.html",
			);
			const timelineHtml = fs.readFileSync(timelinePath, "utf8");
			expect(timelineHtml).toContain("data:image/png;base64,");
			expect(timelineHtml).toContain("before-change"); // epoch chip
			expect(timelineHtml).toContain("dbg — timeline");

			// ── dbg replay: restore the baseline capture, page URL matches ──
			const replay = dbg("replay", String(pair.baseline.captureId), "--json");
			expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
			expect((JSON.parse(replay.stdout) as { ok: boolean }).ok).toBe(true);
			const href = dbg("e", "location.href", "--json");
			expect(href.exitCode, href.stdout + href.stderr).toBe(0);
			expect(
				(JSON.parse(href.stdout) as { value?: string }).value,
			).toBe(fixtureUrl);

			// ── explicit anchors also resolve ──
			const atCapture = dbg(
				"after",
				"--at",
				`capture:${pair.baseline.captureId}`,
				"--json",
			);
			expect(atCapture.exitCode, atCapture.stdout + atCapture.stderr).toBe(0);
			expect(
				(JSON.parse(atCapture.stdout) as { ok: boolean }).ok,
			).toBe(true);

			// ── stop; no orphan Chrome ──
			const stop = dbg("record", "--stop", "--json");
			expect(stop.exitCode, stop.stdout + stop.stderr).toBe(0);
			const deadline = Date.now() + 5000;
			while (isAlive(chromePid) && Date.now() < deadline) {
				await sleep(100);
			}
			expect(isAlive(chromePid)).toBe(false);
		},
	);
});

describe.runIf(!hasChrome)("dbg after (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
