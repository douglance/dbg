// Phase 4 e2e: React dev-build fixture (esbuild-bundled at test time with
// NODE_ENV=development — documented choice: no prebuilt bundle checked in).
// record → mark → mutate ColorCard's padding+color → dbg after --json blames
// the ColorCard component and styleChanges carries the padding delta; the
// report labels the region "ColorCard"; regions rows land in the store.
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-blame-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-blame-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-blame-db-"));
const serveDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-blame-serve-"));
const chromeProfileDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "dbg-blame-profile-"),
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

describe.runIf(hasChrome)("component blame + style diff (e2e)", () => {
	let server: ChildProcess;
	let fixtureUrl: string;

	beforeAll(async () => {
		killDaemon();
		// Bundle the React dev fixture (function names + fibers intact).
		buildSync({
			entryPoints: [path.resolve(__dirname, "fixtures/react-app/app.jsx")],
			bundle: true,
			outfile: path.join(serveDir, "bundle.js"),
			define: { "process.env.NODE_ENV": '"development"' },
			jsx: "automatic",
		});
		fs.writeFileSync(
			path.join(serveDir, "index.html"),
			'<!doctype html><html><head><meta charset="utf-8"><title>blame fixture</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
		);
		server = spawn(
			process.execPath,
			[path.resolve(__dirname, "fixtures/static-server.js"), serveDir],
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
		for (const dir of [workDir, dbDir, serveDir, chromeProfileDir]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("blames ColorCard and reports its padding/color delta", {
		timeout: 120000,
	}, async () => {
		const start = dbg("record", fixtureUrl, "--viewport", "800x600", "--json");
		expect(start.exitCode, start.stdout + start.stderr).toBe(0);
		const chromePid = (
			JSON.parse(start.stdout) as { recording?: { pid?: number } }
		).recording?.pid as number;
		expect(chromePid).toBeGreaterThan(0);

		// Let React render + the post-render mutation capture settle, so the
		// baseline capture (last before the mark) has the rendered card.
		await sleep(2500);
		const mark = dbg("mark", "before-change", "--json");
		expect(mark.exitCode, mark.stdout + mark.stderr).toBe(0);

		const mutate = dbg("e", "window.__mutateCard(); 'ok'");
		expect(mutate.exitCode, mutate.stdout + mutate.stderr).toBe(0);
		await sleep(2500);

		const after = dbg("after", "--json");
		expect(after.exitCode, after.stdout + after.stderr).toBe(0);
		const response = JSON.parse(after.stdout) as {
			ok: boolean;
			pair?: { diffPercent: number };
			regions?: Array<{
				label: string;
				component: string | null;
				file: string | null;
				causal: boolean;
				box: { w: number; h: number };
			}>;
			styleChanges?: Array<{
				selector: string;
				prop: string;
				before: string;
				after: string;
			}>;
			reportPath?: string;
		};
		expect(response.ok, after.stdout).toBe(true);
		expect(response.pair?.diffPercent).toBeGreaterThan(0);

		// ── blame: at least one region names the ColorCard component ──
		expect(response.regions?.length).toBeGreaterThan(0);
		const cardRegion = response.regions?.find(
			(r) => r.component === "ColorCard",
		);
		expect(cardRegion, JSON.stringify(response.regions)).toBeDefined();

		// ── style diff: padding or color delta on the card ──
		const cardChanges = (response.styleChanges ?? []).filter((c) =>
			c.selector.includes("color-card"),
		);
		expect(
			cardChanges.some(
				(c) =>
					c.prop.startsWith("padding") ||
					c.prop === "color" ||
					c.prop === "background-color",
			),
			JSON.stringify(response.styleChanges),
		).toBe(true);
		const padding = cardChanges.find((c) => c.prop === "padding-top");
		expect(padding?.before).toBe("8px");
		expect(padding?.after).toBe("40px");

		// ── report labels the region ──
		const html = fs.readFileSync(response.reportPath as string, "utf8");
		expect(html).toContain("ColorCard");

		// ── regions rows queryable ──
		const regions = dbg(
			"q",
			"SELECT diff_id, component FROM regions",
			"--json",
		);
		expect(regions.exitCode, regions.stdout + regions.stderr).toBe(0);
		const regionRows = (JSON.parse(regions.stdout) as { rows: unknown[][] })
			.rows;
		expect(regionRows.length).toBeGreaterThan(0);
		expect(regionRows.some((r) => r[1] === "ColorCard")).toBe(true);

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

describe.runIf(!hasChrome)("component blame (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
