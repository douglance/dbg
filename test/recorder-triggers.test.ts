// Phase 2 recorder integration: DOM mutations trigger debounced, hash-deduped
// captures; files saved in the watched cwd annotate the next capture; edit
// bursts after FS quiet open auto epochs; `dbg mark` stamps named epochs; and
// record.status reports captureCount/epochCount/lastCaptureTs.
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
const SOCKET_PATH = "/tmp/dbg-recorder-triggers-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

// The watched cwd and the events DB live in SEPARATE temp dirs: the store's
// WAL writes would otherwise show up as FS events inside the watched tree and
// pollute changed_files / defeat FS-quiet detection.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-triggers-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-triggers-db-"));
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

function query(sql: string): Record<string, unknown>[] {
	const result = dbg("q", sql, "--json");
	expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	const parsed = JSON.parse(result.stdout) as {
		columns: string[];
		rows: unknown[][];
	};
	return parsed.rows.map((row) =>
		Object.fromEntries(parsed.columns.map((col, i) => [col, row[i]])),
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

describe.runIf(hasChrome)("recorder triggers + annotations", () => {
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
	});

	it(
		"captures on mutation, annotates changed files, stamps epochs",
		{ timeout: 120000 },
		async () => {
			// ── record.start with a lowered auto-epoch idle threshold ──
			const start = dbg(
				"record",
				fixtureUrl,
				"--viewport",
				"800x600",
				"--idle",
				"500",
				"--json",
			);
			expect(start.exitCode, start.stdout + start.stderr).toBe(0);
			const startResponse = JSON.parse(start.stdout) as {
				ok: boolean;
				recording?: { running: boolean; pid?: number };
			};
			expect(startResponse.ok).toBe(true);
			const chromePid = startResponse.recording?.pid as number;
			expect(chromePid).toBeGreaterThan(0);

			// Let the initial page settle (post-load mutation pings dedupe away).
			await sleep(1500);
			// (dbg q's SQL dialect has no AS aliases; COUNT(*) surfaces as "count")
			const baseline = query(
				"SELECT COUNT(*) FROM captures WHERE session_id = 'recorder'",
			);
			const baselineCount = Number(baseline[0].count);
			expect(baselineCount).toBeGreaterThanOrEqual(1);

			// ── (a) mutation 1: MutationObserver → binding → capture ──
			const mut1 = dbg(
				"e",
				"document.body.append(Object.assign(document.createElement('h2'),{textContent:'mutation one'})); 'ok'",
			);
			expect(mut1.exitCode, mut1.stdout + mut1.stderr).toBe(0);
			await sleep(2500); // 300ms in-page debounce + screenshot + insert

			// ── (b) scratch file saved in the watched cwd between captures ──
			// >= 500ms of FS quiet has passed since record.start, so this also
			// opens an auto epoch (inserted before the file accumulates).
			fs.writeFileSync(path.join(workDir, "scratch.txt"), "hello recorder");
			await sleep(400); // let the FS event reach the daemon

			// ── (c) named epoch via dbg mark ──
			const mark = dbg("mark", "checkpoint", "--json");
			expect(mark.exitCode, mark.stdout + mark.stderr).toBe(0);
			expect((JSON.parse(mark.stdout) as { ok: boolean }).ok).toBe(true);

			// ── (a cont.) mutation 2 after an idle gap ──
			const mut2 = dbg(
				"e",
				"document.body.append(Object.assign(document.createElement('h2'),{textContent:'mutation two'})); 'ok'",
			);
			expect(mut2.exitCode, mut2.stdout + mut2.stderr).toBe(0);
			await sleep(2500);

			// ── captures: >= 2 new distinct rows, all hashes unique ──
			const captures = query(
				"SELECT id, hash, changed_files, hmr_modules, epoch_id FROM captures WHERE session_id = 'recorder' ORDER BY id",
			);
			expect(captures.length).toBeGreaterThanOrEqual(baselineCount + 2);
			const hashes = captures.map((c) => c.hash as string);
			expect(new Set(hashes).size).toBe(hashes.length);

			// ── changed_files: exactly one capture carries scratch.txt, then
			// the accumulator is cleared ──
			const carrying = captures.filter((c) =>
				(JSON.parse(c.changed_files as string) as string[]).includes(
					"scratch.txt",
				),
			);
			expect(carrying.length).toBe(1);

			// ── epochs: >= 2 rows, >= 1 auto, one named "checkpoint" ──
			const epochs = query(
				"SELECT id, name, auto FROM epochs WHERE session_id = 'recorder' ORDER BY id",
			);
			expect(epochs.length).toBeGreaterThanOrEqual(2);
			expect(epochs.some((e) => Number(e.auto) === 1)).toBe(true);
			const named = epochs.find((e) => e.name === "checkpoint");
			expect(named).toBeDefined();
			expect(Number(named?.auto)).toBe(0);

			// ── captures carry epoch_id: the post-mark capture points at the
			// named epoch ──
			const last = captures[captures.length - 1];
			expect(Number(last.epoch_id)).toBe(Number(named?.id));

			// ── record.status gains lastCaptureTs / captureCount / epochCount ──
			const status = dbg("record", "--status", "--json");
			expect(status.exitCode, status.stdout + status.stderr).toBe(0);
			const statusResponse = JSON.parse(status.stdout) as {
				recording?: {
					running: boolean;
					captureCount?: number;
					epochCount?: number;
					lastCaptureTs?: number | null;
				};
			};
			expect(statusResponse.recording?.running).toBe(true);
			expect(statusResponse.recording?.captureCount).toBe(captures.length);
			expect(statusResponse.recording?.epochCount).toBe(epochs.length);
			expect(statusResponse.recording?.lastCaptureTs).toBeGreaterThan(0);

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

describe.runIf(!hasChrome)("recorder triggers (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
