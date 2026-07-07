// Phase 5 e2e: dbg shoot <Component.tsx> — the esbuild component harness.
// Two shoots of the same component with different --props must produce
// different pixels (diffPngs nonzero); output is clipped to #dbg-root.
//
// Requires a real Chrome-compatible browser; skipped when none is installed.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffPngs } from "../packages/diff/src/index.js";
import { resolveChromeExecutable } from "../packages/launcher/src/index.js";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");
const SOCKET_PATH = "/tmp/dbg-harness-test.sock";

let hasChrome = true;
try {
	resolveChromeExecutable();
} catch {
	hasChrome = false;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-harness-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-harness-db-"));
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

describe.runIf(hasChrome)("dbg shoot — component harness (e2e)", () => {
	beforeAll(() => {
		killDaemon();
	});

	afterAll(async () => {
		killDaemon();
		await sleep(200);
		fs.rmSync(workDir, { recursive: true, force: true });
		fs.rmSync(dbDir, { recursive: true, force: true });
	});

	it(
		"renders Button.tsx with two prop sets; the PNGs diff nonzero",
		{ timeout: 120000 },
		() => {
			const buttonPath = path.resolve(
				__dirname,
				"fixtures/react-app/Button.tsx",
			);

			const green = dbg(
				"shoot",
				buttonPath,
				"--props",
				'{"tone":"green"}',
				"--name",
				"btn-green",
				"--json",
			);
			expect(green.exitCode, green.stdout + green.stderr).toBe(0);
			const red = dbg(
				"shoot",
				buttonPath,
				"--props",
				'{"tone":"red","label":"changed label"}',
				"--name",
				"btn-red",
				"--json",
			);
			expect(red.exitCode, red.stdout + red.stderr).toBe(0);

			const greenShot = (
				JSON.parse(green.stdout) as {
					shots?: Array<{ path: string }>;
				}
			).shots?.[0];
			const redShot = (
				JSON.parse(red.stdout) as { shots?: Array<{ path: string }> }
			).shots?.[0];
			expect(greenShot && redShot).toBeTruthy();

			const greenPng = fs.readFileSync((greenShot as { path: string }).path);
			const redPng = fs.readFileSync((redShot as { path: string }).path);
			const diff = diffPngs(greenPng, redPng);
			expect(diff.diffPixels).toBeGreaterThan(0);

			// clipped to the harness root, not the whole viewport
			expect(PNG.sync.read(greenPng).width).toBeLessThan(1280);
		},
	);
});

describe.runIf(!hasChrome)("dbg shoot harness (no Chrome)", () => {
	it.skip("skipped: no Chrome-compatible browser found (set $DBG_CHROME)", () => {});
});
