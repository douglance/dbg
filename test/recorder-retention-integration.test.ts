// Retention integration: record with tiny budgets, force captures past the
// budget, and assert the tiered decay end-to-end — oldest non-protected
// captures decay to thumb/meta, epoch anchors + diff baselines + the newest
// stay full, `dbg after` on a decayed anchor returns a CTA (not a crash),
// and the timeline caps frames / renders placeholders for meta frames.
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-retention-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-retention-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-retention-db-"));
const chromeProfileDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "dbg-retention-profile-"),
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

function captureTiers(): Array<{ id: number; tier: string }> {
	const result = dbg(
		"q",
		"SELECT id, tier FROM captures WHERE session_id = 'recorder' ORDER BY id",
		"--json",
	);
	expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	return (JSON.parse(result.stdout) as { rows: unknown[][] }).rows.map(
		(row) => ({ id: Number(row[0]), tier: String(row[1]) }),
	);
}

/** Mutate the page and wait until a new captures row lands. */
async function mutateAndWaitForCapture(label: string): Promise<void> {
	const before = captureTiers().length;
	const mutate = dbg(
		"e",
		`document.body.append(Object.assign(document.createElement('h2'),{textContent:'retention ${label} ${Math.random()}'})); 'ok'`,
	);
	expect(mutate.exitCode, mutate.stdout + mutate.stderr).toBe(0);
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (captureTiers().length > before) return;
		await sleep(100);
	}
	throw new Error(`mutation "${label}" produced no capture within 5s`);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(hasChrome)("recorder retention integration", () => {
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

	it(
		"decays over-budget frames to thumbs, protecting anchors and diff baselines",
		{ timeout: 120000 },
		async () => {
			const start = dbg(
				"record",
				fixtureUrl,
				"--viewport",
				"800x600",
				"--max-frames",
				"3",
				"--json",
			);
			expect(start.exitCode, start.stdout + start.stderr).toBe(0);

			// Epoch anchor: the initial capture is the last at/before this mark.
			const mark = dbg("mark", "checkpoint", "--json");
			expect(mark.exitCode, mark.stdout + mark.stderr).toBe(0);

			// Force >3 distinct captures.
			for (const label of ["one", "two", "three", "four"]) {
				await mutateAndWaitForCapture(label);
			}

			// Diff vs the mark anchor: protects baseline + after captures.
			const after = dbg("after", "--json");
			expect(after.exitCode, after.stdout + after.stderr).toBe(0);
			const pair = (
				JSON.parse(after.stdout) as {
					pair?: {
						baseline: { captureId: number };
						after: { captureId: number };
					};
				}
			).pair;
			expect(pair).toBeDefined();

			// One more capture so retention runs with the diff protection live.
			await mutateAndWaitForCapture("five");

			const rows = captureTiers();
			const byId = new Map(rows.map((r) => [r.id, r.tier]));
			// Budget respected (protected captures can exceed it; here they don't).
			const fullCount = rows.filter((r) => r.tier === "full").length;
			expect(fullCount).toBeLessThanOrEqual(3);
			// The oldest non-protected capture has decayed.
			expect(rows.some((r) => r.tier === "thumb" || r.tier === "meta")).toBe(
				true,
			);
			// Epoch anchor (initial capture) + diff pair never decay below full.
			expect(byId.get(rows[0].id)).toBe("full");
			expect(byId.get(pair?.baseline.captureId as number)).toBe("full");
			expect(byId.get(pair?.after.captureId as number)).toBe("full");

			// Thumb rows point at real ≤320px-wide thumb blobs under blobs/.
			const thumbRow = dbg(
				"q",
				"SELECT png_path FROM captures WHERE tier = 'thumb' LIMIT 1",
				"--json",
			);
			const thumbPath = String(
				(JSON.parse(thumbRow.stdout) as { rows: unknown[][] }).rows[0][0],
			);
			expect(thumbPath).toContain(`blobs${path.sep}`);
			expect(thumbPath).toContain("-thumb.png");
			expect(fs.existsSync(thumbPath)).toBe(true);

			// Status exposes retention visibility.
			const status = JSON.parse(dbg("record", "--status", "--json").stdout) as {
				recording?: {
					diskBytes?: number;
					fullFrames?: number;
					thumbFrames?: number;
					metaFrames?: number;
					eventsRows?: number;
				};
			};
			expect(status.recording?.fullFrames).toBe(fullCount);
			expect(status.recording?.thumbFrames).toBeGreaterThanOrEqual(1);
			expect(status.recording?.diskBytes).toBeGreaterThan(0);
			// Total live blob bytes stay inside the (default 100MB) byte budget.
			expect(status.recording?.diskBytes).toBeLessThanOrEqual(
				100 * 1024 * 1024,
			);
			expect(status.recording?.eventsRows).toBeGreaterThan(0);

			// Timeline caps embedded frames and says so.
			const timeline = dbg("timeline", "--limit", "2", "--json");
			expect(timeline.exitCode, timeline.stdout + timeline.stderr).toBe(0);
			expect(timeline.stdout).toContain("showing last 2 of");

			const stop = dbg("record", "--stop", "--json");
			expect(stop.exitCode, stop.stdout + stop.stderr).toBe(0);
		},
	);

	it(
		"meta decay: after on a decayed anchor returns a CTA; timeline shows a placeholder",
		{ timeout: 120000 },
		async () => {
			// Impossible byte budget: everything non-protected decays to meta.
			const start = dbg(
				"record",
				fixtureUrl,
				"--viewport",
				"800x600",
				"--max-frames",
				"1",
				"--max-bytes",
				"1000",
				"--json",
			);
			expect(start.exitCode, start.stdout + start.stderr).toBe(0);
			await mutateAndWaitForCapture("meta-phase");

			const rows = captureTiers();
			const metaRow = rows.find((r) => r.tier === "meta");
			expect(metaRow, JSON.stringify(rows)).toBeDefined();

			// `dbg after` on a meta anchor: clear error + CTA, never a crash.
			const after = dbg("after", "--at", `capture:${metaRow?.id}`, "--json");
			expect(after.exitCode).not.toBe(0);
			const output = after.stdout + after.stderr;
			expect(output).toContain("decayed");
			expect(output).toContain("nearest full capture");
			expect(output).toMatch(/dbg after --at capture:\d+/);

			// Timeline renders meta frames as placeholder cards.
			const timeline = dbg("timeline", "--json");
			expect(timeline.exitCode, timeline.stdout + timeline.stderr).toBe(0);
			const timelinePath = path.join(
				fs.realpathSync(workDir),
				".dbg",
				"recordings",
				"timeline.html",
			);
			const html = fs.readFileSync(timelinePath, "utf8");
			expect(html).toContain("pixels pruned");

			const stop = dbg("record", "--stop", "--json");
			expect(stop.exitCode, stop.stdout + stop.stderr).toBe(0);
		},
	);
});

describe.runIf(!hasChrome)("recorder retention integration (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
