// Plan Y end-to-end gate: record a user flow, replay it, then prove readiness
// failure is reported when a recorded element disappears.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCK = "/tmp/dbg-plan-y.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-plany-"));
const db = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "dbg-plany-db-")),
	"e.db",
);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-plany-prof-"));

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

describe.runIf(hasChrome)("Plan Y — flow record and replay", () => {
	let server: ChildProcess;
	let url: string;

	beforeAll(async () => {
		killDaemon();
		server = spawn(
			process.execPath,
			[path.resolve(__dirname, "fixtures/form-server.js")],
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

	it("records steps, replays successfully, then fails when submit disappears", {
		timeout: 120000,
	}, async () => {
		const rec = dbg("record", url, "--json");
		expect(rec.exitCode, rec.stdout + rec.stderr).toBe(0);
		const chromePid = (
			JSON.parse(dbg("record", "--status", "--json").stdout) as {
				recording?: { pid?: number };
			}
		).recording?.pid as number;
		await sleep(1000);

		const altUrl = `${url}?flow=start`;
		const recAtUrl = dbg("flow", "record", "f-url", "--url", altUrl, "--json");
		expect(recAtUrl.exitCode, recAtUrl.stdout + recAtUrl.stderr).toBe(0);
		const loc = dbg("e", "location.href", "--json");
		expect(loc.exitCode, loc.stdout + loc.stderr).toBe(0);
		expect(
			String((JSON.parse(loc.stdout) as { value?: string }).value),
		).toContain("?flow=start");
		expect(dbg("flow", "stop", "--json").exitCode).toBe(0);

		expect(dbg("flow", "record", "f1", "--json").exitCode).toBe(0);
		expect(
			dbg("e", "window.scrollTo(0, 900); 'scrolled'", "--json").exitCode,
		).toBe(0);
		await sleep(350);
		expect(
			dbg("e", "document.querySelector('#name').click()", "--json").exitCode,
		).toBe(0);
		await sleep(150);
		expect(
			dbg(
				"e",
				"var n=document.querySelector('#name'); n.value='hello'; n.dispatchEvent(new Event('change',{bubbles:true}))",
				"--json",
			).exitCode,
		).toBe(0);
		await sleep(150);
		expect(
			dbg("e", "document.querySelector('#submit').click()", "--json").exitCode,
		).toBe(0);
		await sleep(150);
		expect(dbg("flow", "stop", "--json").exitCode).toBe(0);

		const show = dbg("flow", "show", "f1", "--json");
		expect(show.exitCode, show.stdout + show.stderr).toBe(0);
		const showParsed = JSON.parse(show.stdout) as { rows: unknown[][] };
		expect(showParsed.rows.map((r) => r[2])).toEqual([
			"scroll",
			"click",
			"input",
			"click",
		]);
		expect(showParsed.rows[0][5]).toBe("900");
		expect(showParsed.rows.map((r) => r[3])).toEqual([
			null,
			"#name",
			"#name",
			"#submit",
		]);

		const run1 = dbg("flow", "run", "f1", "--json");
		expect(run1.exitCode, run1.stdout + run1.stderr).toBe(0);
		const run1Parsed = JSON.parse(run1.stdout) as {
			flowRun: {
				status: string;
				stepsTotal: number;
				stepsPassed: number;
				steps: Array<{ captureId: number | null }>;
			};
		};
		expect(run1Parsed.flowRun.status).toBe("passed");
		expect(run1Parsed.flowRun.stepsPassed).toBe(run1Parsed.flowRun.stepsTotal);
		expect(
			run1Parsed.flowRun.steps.every((s) => typeof s.captureId === "number"),
		).toBe(true);

		expect(dbg("e", "fetch('/break').then(()=>0)", "--json").exitCode).toBe(0);
		await sleep(200);

		const run2 = dbg("flow", "run", "f1", "--step-timeout", "1500", "--json");
		expect(run2.exitCode, run2.stdout + run2.stderr).toBe(0);
		const run2Parsed = JSON.parse(run2.stdout) as {
			flowRun: {
				status: string;
				steps: Array<{
					kind: string;
					selector: string | null;
					status: string;
					error: string | null;
					captureId: number | null;
				}>;
			};
		};
		expect(run2Parsed.flowRun.status).toBe("failed");
		const failedSubmit = run2Parsed.flowRun.steps.find(
			(s) => s.kind === "click" && s.selector === "#submit",
		);
		expect(failedSubmit?.status).toBe("failed");
		expect(failedSubmit?.error).toContain("readiness");
		expect(typeof failedSubmit?.captureId).toBe("number");

		const q = dbg("q", "SELECT COUNT(*) FROM flow_run_steps", "--json");
		expect(q.exitCode, q.stdout + q.stderr).toBe(0);
		expect(
			Number((JSON.parse(q.stdout) as { rows: unknown[][] }).rows[0][0]),
		).toBeGreaterThan(0);

		expect(dbg("record", "--stop", "--json").exitCode).toBe(0);
		const deadline = Date.now() + 5000;
		while (isAlive(chromePid) && Date.now() < deadline) {
			await sleep(100);
		}
		expect(isAlive(chromePid)).toBe(false);
	});
});

describe.runIf(!hasChrome)(
	"Plan Y — flow record and replay (no Chrome)",
	() => {
		it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
	},
);
