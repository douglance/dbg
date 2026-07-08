// Plan U end-to-end gate: a seeded $DBG_CLAUDE_DIR (synthetic history.jsonl
// prompt) + a fixture git repo + a live recording where the test saves a
// watched file then triggers a console.error. ONE real SQL query via `dbg q`
// over the `timeline` union returns the causal chain (prompt → edit → capture
// → error in ts order), and `dbg timeline` HTML contains a commit chip.
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-plan-u-e2e.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

// Isolated dirs: watched git repo, events DB, Chrome profile, and a fake
// ~/.claude — all separate so store WAL writes never pollute the FS watch.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planu-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planu-db-"));
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planu-claude-"));
const chromeProfileDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "dbg-planu-profile-"),
);
const EVENTS_DB_PATH = path.join(dbDir, "events.db");

function projectSlug(dir: string): string {
	return dir.replace(/[/.]/g, "-");
}

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
				DBG_CLAUDE_DIR: claudeDir,
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(hasChrome)("Plan U e2e — unified causal chain", () => {
	let server: ChildProcess;
	let fixtureUrl: string;
	let promptTs = 0;

	beforeAll(async () => {
		killDaemon();

		// ── fixture git repo ──
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: workDir, stdio: "ignore" });
		git("init");
		git("config", "user.email", "test@dbg.dev");
		git("config", "user.name", "dbg test");
		fs.writeFileSync(path.join(workDir, "README.md"), "# fixture\n");
		git("add", "-A");
		git("commit", "-m", "seed: add coupon field to cart");

		// ── seeded ~/.claude history.jsonl prompt scoped to this repo ──
		// The daemon scopes agent_prompts to process.cwd(), which on macOS is
		// the realpath (/private/var/… not /var/…) — seed the resolved path so
		// the project slug matches.
		const realWork = fs.realpathSync(workDir);
		promptTs = Date.now() - 10_000;
		const historyLine = JSON.stringify({
			display: "add coupon field",
			timestamp: promptTs,
			project: realWork,
		});
		fs.writeFileSync(path.join(claudeDir, "history.jsonl"), `${historyLine}\n`);
		fs.mkdirSync(path.join(claudeDir, "projects", projectSlug(realWork)), {
			recursive: true,
		});

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
		server?.kill("SIGKILL");
		await sleep(200);
		for (const dir of [workDir, dbDir, claudeDir, chromeProfileDir]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("one timeline SQL query returns prompt → edit → capture → error in ts order", {
		timeout: 120000,
	}, async () => {
		// ── record.start ──
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
		await sleep(1500); // initial page settle

		// ── save a watched file → edits row (+ next-capture annotation) ──
		fs.writeFileSync(path.join(workDir, "Cart.tsx"), "// coupon field\n");
		await sleep(500);

		// ── DOM mutation → capture AFTER the edit ──
		const mut = dbg(
			"e",
			"document.body.append(Object.assign(document.createElement('h2'),{textContent:'coupon'})); 'ok'",
		);
		expect(mut.exitCode, mut.stdout + mut.stderr).toBe(0);
		await sleep(2500);

		// ── console.error AFTER the capture ──
		const err = dbg("e", "console.error('coupon-broke'); 'ok'");
		expect(err.exitCode, err.stdout + err.stderr).toBe(0);
		await sleep(1200);

		// ── ONE real SQL query over the unified timeline ──
		const rows = query(
			`SELECT ts, kind, label FROM timeline WHERE ts >= ${promptTs} ORDER BY ts`,
		);
		const kinds = new Set(rows.map((r) => String(r.kind)));
		for (const required of ["prompt", "edit", "capture", "error"]) {
			expect(kinds.has(required), `missing kind ${required}`).toBe(true);
		}

		const firstTs = (kind: string): number =>
			Number(rows.find((r) => r.kind === kind)?.ts);
		const pTs = firstTs("prompt");
		const eTs = firstTs("edit");
		const errTs = firstTs("error");
		// prompt (seeded 10s ago) precedes the edit, which precedes the error.
		expect(pTs).toBeLessThan(eTs);
		expect(eTs).toBeLessThan(errTs);
		// a capture exists between the edit and the error (the mutation frame).
		const capBetween = rows.some(
			(r) =>
				r.kind === "capture" && Number(r.ts) >= eTs && Number(r.ts) <= errTs,
		);
		expect(capBetween).toBe(true);
		// the seeded prompt text surfaced as a timeline label.
		expect(rows.some((r) => String(r.label).includes("coupon"))).toBe(true);

		// ── edits are a first-class table too ──
		const edits = query("SELECT path FROM edits WHERE session_id = 'recorder'");
		expect(edits.some((e) => String(e.path).includes("Cart.tsx"))).toBe(true);

		// ── dbg timeline HTML contains a commit chip ──
		const timeline = dbg("timeline", "--json");
		expect(timeline.exitCode, timeline.stdout + timeline.stderr).toBe(0);
		const msg = (JSON.parse(timeline.stdout) as { messages?: string[] })
			.messages?.[0];
		expect(msg).toBeDefined();
		const htmlPath = String(msg).split(": ").pop() as string;
		const html = fs.readFileSync(htmlPath.trim(), "utf8");
		expect(html).toContain("marker commit");
		expect(html).toContain("coupon");

		// ── stop ──
		const stop = dbg("record", "--stop", "--json");
		expect(stop.exitCode, stop.stdout + stop.stderr).toBe(0);
	});
});

describe.runIf(!hasChrome)("Plan U e2e (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
