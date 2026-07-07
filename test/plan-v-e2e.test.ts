// Plan V end-to-end gate. `dbg after` re-captures the live page (URL unchanged
// → no reload), so the test mutates the live page directly between the anchor
// mark and `after`:
//   (a) save a watched file + trigger console.error → `dbg why` names the file
//   (b) fire a fetch to a new URL that 500s → networkDiff catches it
//   (c) set a localStorage key + strip a button's accessible name →
//       stateChanges + a NEW a11y issue
// report.html gains the network-diff / state / a11y panels.
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-plan-v-e2e.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planv-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planv-db-"));
const chromeProfileDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "dbg-planv-profile-"),
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

describe.runIf(hasChrome)("Plan V e2e — verdicts", () => {
	let server: ChildProcess;
	let fixtureUrl: string;

	beforeAll(async () => {
		killDaemon();
		server = spawn(
			process.execPath,
			[path.resolve(__dirname, "fixtures/planv-server.js")],
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
		server?.kill("SIGKILL");
		await sleep(200);
		for (const dir of [workDir, dbDir, chromeProfileDir]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it(
		"dbg why / networkDiff / stateChanges / a11y",
		{ timeout: 120000 },
		async () => {
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
			expect((JSON.parse(start.stdout) as { ok: boolean }).ok).toBe(true);
			await sleep(1500); // initial capture: labeled button, empty storage, /api/ok

			// Clean baseline anchor.
			const mark = dbg("mark", "baseline", "--json");
			expect(mark.exitCode, mark.stdout + mark.stderr).toBe(0);

			// `after` re-captures the LIVE page (the URL is unchanged, so it does
			// not reload) — so mutate the live DOM/state directly: set a
			// localStorage key (→ stateChanges), strip the button's accessible
			// name (→ new a11y issue), and fire the changed fetch (→ networkDiff,
			// recorded before `after` runs). Then save a watched file + raise an
			// error for `dbg why`.
			const mutate = dbg(
				"e",
				"localStorage.setItem('broke','1');" +
					"fetch('/api/error').catch(()=>{});" +
					"var b=document.getElementById('btn'); b.textContent=''; b.removeAttribute('aria-label');" +
					"'ok'",
			);
			expect(mutate.exitCode, mutate.stdout + mutate.stderr).toBe(0);
			await sleep(700); // 500 response records + mutation-capture settles
			fs.writeFileSync(path.join(workDir, "Cart.tsx"), "// coupon field\n");
			await sleep(400);
			const err = dbg("e", "console.error('boom-coupon'); 'ok'");
			expect(err.exitCode, err.stdout + err.stderr).toBe(0);
			await sleep(1000);

			// ── dbg after --at mark:baseline ──
			const after = dbg("after", "baseline", "--json");
			expect(after.exitCode, after.stdout + after.stderr).toBe(0);
			const afterRes = JSON.parse(after.stdout) as {
				ok: boolean;
				reportPath?: string;
				networkDiff?: {
					added: Array<{ pattern: string; status: number }>;
					removed: Array<{ pattern: string }>;
					statusChanged: Array<{ pattern: string; after: number }>;
				};
				stateChanges?: Array<{ key: string; change: string }>;
				a11yNew?: Array<{ rule: string; selector: string }>;
			};
			expect(afterRes.ok).toBe(true);

			// (b) networkDiff caught the URL/status flip (/api/ok → /api/error 500).
			const nd = afterRes.networkDiff;
			expect(nd).toBeDefined();
			const netPatterns = [
				...(nd?.added ?? []).map((a) => a.pattern),
				...(nd?.removed ?? []).map((r) => r.pattern),
				...(nd?.statusChanged ?? []).map((s) => s.pattern),
			].join(" ");
			expect(netPatterns).toContain("api/error");

			// (c) stateChanges shows the new localStorage key.
			const broke = (afterRes.stateChanges ?? []).find(
				(c) => c.key === "broke",
			);
			expect(broke?.change).toBe("added");

			// (c) a NEW a11y issue: the button lost its accessible name.
			expect((afterRes.a11yNew ?? []).map((i) => i.rule)).toContain(
				"control-missing-name",
			);

			// report.html gains the new panels.
			const html = fs.readFileSync(String(afterRes.reportPath), "utf8");
			expect(html).toContain("New a11y issues");
			expect(html).toContain("State changes");
			expect(html).toContain("Network diff");

			// (a) dbg why names the saved file.
			const why = dbg("why", "boom-coupon", "--json");
			expect(why.exitCode, why.stdout + why.stderr).toBe(0);
			const whyRes = JSON.parse(why.stdout) as {
				ok: boolean;
				why?: {
					answer: string;
					edits: Array<{ path: string }>;
				};
			};
			expect(whyRes.ok).toBe(true);
			expect(whyRes.why?.answer).toContain("Cart.tsx");
			expect(whyRes.why?.edits.some((e) => e.path.includes("Cart.tsx"))).toBe(
				true,
			);

			dbg("record", "--stop", "--json");
		},
	);
});

describe.runIf(!hasChrome)("Plan V e2e (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
