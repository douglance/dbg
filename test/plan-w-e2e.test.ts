// Plan W end-to-end gate: taps (logpoints) on a page target and a node target.
//   - tap a function line, trigger it → tap_hits row carries the expr VALUE
//   - the resolved-location echo is asserted ("armed on <url>:<line>")
//   - the `__dbg_tap:` sentinel is suppressed from `after` consoleDelta and
//     `dbg why` output (routed to tap_hits, never surfaced as user console)
//   - tap list / hits / rm work
// Page target needs Chrome (skipped otherwise); node target always runs.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

function makeDbg(
	socket: string,
	workDir: string,
	dbPath: string,
	profile: string,
) {
	return (...args: string[]) => {
		try {
			const stdout = execFileSync(process.execPath, [CLI, ...args], {
				encoding: "utf8",
				timeout: 60000,
				cwd: workDir,
				env: {
					...process.env,
					DBG_SOCK: socket,
					DBG_EVENTS_DB: dbPath,
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
	};
}

function killDaemon(socket: string): void {
	try {
		const pids = execFileSync("lsof", ["-t", socket], {
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
		fs.unlinkSync(socket);
	} catch {
		// ignore
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function rows(result: { stdout: string }): Record<string, unknown>[] {
	const parsed = JSON.parse(result.stdout) as {
		columns: string[];
		rows: unknown[][];
	};
	return parsed.rows.map((r) =>
		Object.fromEntries(parsed.columns.map((c, i) => [c, r[i]])),
	);
}

// ─── Page target ───
const pSock = "/tmp/dbg-plan-w-page.sock";
const pWork = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planw-p-"));
const pDb = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planw-pdb-")),
	"e.db",
);
const pProfile = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planw-pprof-"));

describe.runIf(hasChrome)("Plan W — page taps", () => {
	const dbg = makeDbg(pSock, pWork, pDb, pProfile);
	let server: ChildProcess;
	let url: string;

	beforeAll(async () => {
		killDaemon(pSock);
		server = spawn(
			process.execPath,
			[path.resolve(__dirname, "fixtures/tap-server.js")],
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
		killDaemon(pSock);
		server?.kill("SIGKILL");
		await sleep(200);
		fs.rmSync(pWork, { recursive: true, force: true });
		fs.rmSync(pProfile, { recursive: true, force: true });
	});

	it("tap fires with the expr value; sentinel suppressed from after/why", {
		timeout: 120000,
	}, async () => {
		expect(dbg("record", url, "--json").exitCode).toBe(0);
		await sleep(1500); // app.js loads

		// Arm the tap on app.js:3 (`return doubled`).
		const add = dbg("tap", "add", "app.js:3", "doubled", "--json");
		expect(add.exitCode, add.stdout + add.stderr).toBe(0);
		const addRes = JSON.parse(add.stdout) as {
			ok: boolean;
			id?: string;
			messages?: string[];
		};
		expect(addRes.ok).toBe(true);
		// resolved-location echo
		expect(addRes.messages?.[0]).toContain("armed on");
		expect(addRes.messages?.[0]).toContain("app.js:3");
		const tapId = addRes.id as string;

		expect(dbg("mark", "baseline", "--json").exitCode).toBe(0);

		// Trigger the tap and a real error.
		expect(dbg("e", "compute(21)").exitCode).toBe(0);
		await sleep(400);
		expect(dbg("e", "console.error('real-error-xyz')").exitCode).toBe(0);
		await sleep(800);

		// tap_hits carries the expression value (42).
		const hits = rows(dbg("q", "SELECT value FROM tap_hits", "--json"));
		expect(hits.map((h) => String(h.value))).toContain("42");

		// `after` consoleDelta has the real error but NOT the sentinel.
		const after = dbg("after", "baseline", "--json");
		expect(after.exitCode, after.stdout + after.stderr).toBe(0);
		expect(after.stdout).toContain("real-error-xyz");
		expect(after.stdout).not.toContain("__dbg_tap");

		// `dbg why` output does not contain the sentinel.
		const why = dbg("why", "--json");
		expect(why.exitCode, why.stdout + why.stderr).toBe(0);
		expect(why.stdout).not.toContain("__dbg_tap");

		// tap hits / list / rm.
		const tapHits = rows(dbg("tap", "hits", tapId, "--json"));
		expect(tapHits.map((h) => String(h.value))).toContain("42");
		const list = rows(dbg("tap", "list", "--json"));
		expect(list.some((t) => String(t.id) === tapId)).toBe(true);
		expect(dbg("tap", "rm", tapId, "--json").exitCode).toBe(0);
		expect(
			rows(dbg("tap", "list", "--json")).some((t) => String(t.id) === tapId),
		).toBe(false);

		expect(dbg("record", "--stop", "--json").exitCode).toBe(0);
	});
});

// ─── Node target ───
const nSock = "/tmp/dbg-plan-w-node.sock";
const nWork = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planw-n-"));
const nDb = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planw-ndb-")),
	"e.db",
);
const nProfile = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-planw-nprof-"));

describe("Plan W — node taps", () => {
	const dbg = makeDbg(nSock, nWork, nDb, nProfile);
	const fixture = path.resolve(__dirname, "fixtures/tap-node.js");

	beforeAll(() => killDaemon(nSock));
	afterAll(async () => {
		dbg("close");
		killDaemon(nSock);
		await sleep(200);
		fs.rmSync(nWork, { recursive: true, force: true });
	});

	it("tap on a node target carries the expr value (V8 inspector parity)", {
		timeout: 60000,
	}, async () => {
		const run = dbg("run", `node ${fixture}`);
		expect(run.exitCode, run.stdout + run.stderr).toBe(0);
		// --inspect-brk pauses at the first line; continue so the module runs
		// (defines globalThis.compute) and idles on its keep-alive timer.
		expect(dbg("c").exitCode).toBe(0);
		await sleep(400);

		const add = dbg("tap", "add", "tap-node.js:4", "doubled", "--json");
		expect(add.exitCode, add.stdout + add.stderr).toBe(0);
		expect((JSON.parse(add.stdout) as { ok: boolean }).ok).toBe(true);

		expect(dbg("e", "compute(21)").exitCode).toBe(0);
		await sleep(500);

		const hits = rows(dbg("q", "SELECT value FROM tap_hits", "--json"));
		expect(hits.map((h) => String(h.value))).toContain("42");

		expect(dbg("close").exitCode).toBe(0);
	});
});
