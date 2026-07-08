// Plan X end-to-end gate: perf flight recorder against a real page.
//   - record a page, mark a baseline
//   - an edit prepends a tall block (forces a layout shift) and appends a
//     ~3MB <script> (bundle-bytes signal)
//   - `after baseline --json` reports perfDelta.cls.delta > 0 AND
//     perfDelta.bundleBytes.delta > 0; report.html shows the Performance panel
//   - perf_samples has rows; `after --skip-perf` omits perfDelta
// Needs Chrome (skipped otherwise). File-unique socket/DB/profile/port.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCK = "/tmp/dbg-plan-x.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planx-"));
const db = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planx-db-")),
	"e.db",
);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planx-prof-"));

function dbg(...args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 60000,
			cwd: work,
			env: {
				...process.env,
				DBG_SOCK: SOCK,
				DBG_EVENTS_DB: db,
				DBG_CHROME_PROFILE: profile,
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
		const pids = execFileSync("lsof", ["-t", SOCK], {
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
		// none
	}
	try {
		fs.unlinkSync(SOCK);
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

describe.runIf(hasChrome)("Plan X — perf flight recorder", () => {
	let server: ChildProcess;
	let url: string;

	beforeAll(async () => {
		killDaemon();
		server = spawn(
			process.execPath,
			[path.resolve(__dirname, "fixtures/perf-server.js")],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const port = await new Promise<number>((resolve, reject) => {
			let buf = "";
			server.stdout?.on("data", (c: Buffer) => {
				buf += c.toString();
				if (buf.split("\n")[0]) resolve(Number.parseInt(buf, 10));
			});
			server.on("error", reject);
			setTimeout(() => reject(new Error("server timeout")), 5000);
		});
		url = `http://127.0.0.1:${port}/`;
	});

	afterAll(async () => {
		dbg("record", "--stop");
		killDaemon();
		server?.kill("SIGKILL");
		await sleep(200);
		for (const dir of [work, path.dirname(db), profile]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports CLS + bundle-bytes deltas; --skip-perf omits perfDelta", {
		timeout: 120000,
	}, async () => {
		const rec = dbg("record", url, "--viewport", "800x600", "--json");
		expect(rec.exitCode, rec.stdout + rec.stderr).toBe(0);
		const chromePid = (
			JSON.parse(dbg("record", "--status", "--json").stdout) as {
				recording?: { pid?: number };
			}
		).recording?.pid as number;
		await sleep(1000); // initial page + buffered observer settle

		expect(dbg("mark", "baseline", "--json").exitCode).toBe(0);

		// Prepend a tall block (layout shift) and append the big script.
		const mutate = dbg(
			"e",
			"document.body.insertAdjacentHTML('afterbegin','<div style=\"height:600px;background:#c33\">pushdown</div>'); var s=document.createElement('script'); s.src='/big.js'; document.body.appendChild(s); 'ok'",
		);
		expect(mutate.exitCode, mutate.stdout + mutate.stderr).toBe(0);

		// 1s observer flush + script load + capture settle.
		await sleep(2000);

		const after = dbg("after", "baseline", "--json");
		expect(after.exitCode, after.stdout + after.stderr).toBe(0);
		const parsed = JSON.parse(after.stdout) as {
			perfDelta?: {
				cls: { delta: number };
				bundleBytes: {
					anchor: number | null;
					after: number | null;
					delta: number | null;
				};
			};
			reportPath?: string;
		};
		expect(parsed.perfDelta, after.stdout).toBeDefined();
		expect(parsed.perfDelta?.cls.delta).toBeGreaterThan(0);
		expect(parsed.perfDelta?.bundleBytes.delta ?? 0).toBeGreaterThan(0);

		// report.html carries the Performance panel.
		const reportHtml = fs.readFileSync(parsed.reportPath as string, "utf8");
		expect(reportHtml).toContain("Performance");
		expect(reportHtml).toContain("Δbundle_bytes");

		// perf_samples has rows.
		const q = dbg("q", "SELECT COUNT(*) AS c FROM perf_samples", "--json");
		expect(q.exitCode, q.stdout + q.stderr).toBe(0);
		const count = Number(
			(JSON.parse(q.stdout) as { rows: unknown[][] }).rows[0][0],
		);
		expect(count).toBeGreaterThan(0);

		// --skip-perf omits perfDelta.
		const skip = dbg("after", "baseline", "--skip-perf", "--json");
		expect(skip.exitCode, skip.stdout + skip.stderr).toBe(0);
		expect(
			(JSON.parse(skip.stdout) as { perfDelta?: unknown }).perfDelta,
		).toBeUndefined();

		// stop; no orphan Chrome.
		expect(dbg("record", "--stop", "--json").exitCode).toBe(0);
		const deadline = Date.now() + 5000;
		while (isAlive(chromePid) && Date.now() < deadline) {
			await sleep(100);
		}
		expect(isAlive(chromePid)).toBe(false);
	});
});

describe.runIf(!hasChrome)("Plan X — perf flight recorder (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
