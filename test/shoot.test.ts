// Phase 5 e2e: dbg shoot on URLs — deliberate one-off captures.
// - viewport preset produces a PNG with the preset's exact dimensions
// - --selector clips to the element (smaller than the viewport)
// - --states hover produces an @hover PNG that differs from the base
//   (pixel-compare via @dbg/diff)
// - shots also land as captures rows under session 'shoot'
// - no orphan Chrome
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffPngs } from "../packages/diff/src/index.js";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-shoot-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-shoot-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-shoot-db-"));
const serveDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-shoot-serve-"));
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

interface ShootResponse {
	ok: boolean;
	shots?: Array<{ state: string; path: string }>;
}

function shoot(...args: string[]): ShootResponse {
	const result = dbg("shoot", ...args, "--json");
	expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	return JSON.parse(result.stdout) as ShootResponse;
}

describe.runIf(hasChrome)("dbg shoot — URLs (e2e)", () => {
	let server: ChildProcess;
	let fixtureUrl: string;

	beforeAll(async () => {
		killDaemon();
		fs.writeFileSync(
			path.join(serveDir, "index.html"),
			`<!doctype html><html><head><meta charset="utf-8"><title>shoot fixture</title>
			<style>
				body { margin: 0; padding: 24px; background: #ffffff; }
				button { background: #00a55a; color: #fff; border: none; padding: 12px 24px; font-size: 16px; }
				button:hover { background: #c1121f; }
			</style></head>
			<body><button type="button">hover me</button></body></html>`,
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
		killDaemon();
		server.kill("SIGKILL");
		await sleep(200);
		for (const dir of [workDir, dbDir, serveDir]) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("viewport preset produces a PNG with the preset's dimensions", {
		timeout: 120000,
	}, () => {
		const response = shoot(
			fixtureUrl,
			"--viewport",
			"mobile",
			"--name",
			"mobileshot",
		);
		const shotPath = (response.shots ?? [])[0].path;
		// default output dir + default state = bare name
		expect(
			shotPath.endsWith(path.join(".dbg", "shots", "mobileshot.png")),
		).toBe(true);
		const png = PNG.sync.read(fs.readFileSync(shotPath));
		expect(png.width).toBe(390);
		expect(png.height).toBe(844);
	});

	it("--selector clips to the element (smaller than the viewport)", {
		timeout: 120000,
	}, () => {
		const response = shoot(
			fixtureUrl,
			"--selector",
			"button",
			"--name",
			"clipped",
		);
		const png = PNG.sync.read(fs.readFileSync((response.shots ?? [])[0].path));
		expect(png.width).toBeLessThan(1280);
		expect(png.height).toBeLessThan(800);
	});

	it("--states hover: the @hover PNG differs from the base", {
		timeout: 120000,
	}, () => {
		const response = shoot(
			fixtureUrl,
			"--selector",
			"button",
			"--states",
			"hover",
			"--name",
			"hoverbtn",
		);
		expect(response.shots?.map((s) => s.state)).toEqual(["default", "hover"]);
		const [base, hover] = response.shots ?? [];
		expect(hover.path.endsWith("hoverbtn@hover.png")).toBe(true);
		const diff = diffPngs(
			fs.readFileSync(base.path),
			fs.readFileSync(hover.path),
		);
		expect(diff.diffPixels).toBeGreaterThan(0);
	});

	it("file:// targets are URL shoots, not harness lookups", {
		timeout: 120000,
	}, () => {
		const fileUrl = `file://${path.join(fs.realpathSync(serveDir), "index.html")}`;
		const response = shoot(fileUrl, "--name", "filefixture");
		expect(response.ok).toBe(true);
		const png = fs.readFileSync((response.shots ?? [])[0].path);
		expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it("shots land as captures rows under session 'shoot'", () => {
		const rows = dbg(
			"q",
			"SELECT COUNT(*) FROM captures WHERE session_id = 'shoot'",
			"--json",
		);
		expect(rows.exitCode, rows.stdout + rows.stderr).toBe(0);
		const count = Number(
			(JSON.parse(rows.stdout) as { rows: unknown[][] }).rows[0][0],
		);
		expect(count).toBeGreaterThanOrEqual(5); // mobileshot + clipped + hoverbtn x2 + filefixture
	});
});

describe.runIf(!hasChrome)("dbg shoot (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
