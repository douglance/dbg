import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cleanStaleSingletonLock,
	DEFAULT_CHROME_PATHS,
	parseDevToolsActivePort,
	pollDevToolsActivePort,
	resolveChromeExecutable,
} from "../packages/launcher/src/index.js";

describe("resolveChromeExecutable", () => {
	it("prefers $DBG_CHROME when set and present", () => {
		const resolved = resolveChromeExecutable(
			{ DBG_CHROME: "/custom/chrome" },
			(p) => p === "/custom/chrome",
		);
		expect(resolved).toBe("/custom/chrome");
	});

	it("errors when $DBG_CHROME points to a missing executable", () => {
		expect(() =>
			resolveChromeExecutable({ DBG_CHROME: "/missing/chrome" }, () => false),
		).toThrow(/\$DBG_CHROME points to a missing executable/);
	});

	it("falls back to standard paths in preference order", () => {
		const chromium = "/Applications/Chromium.app/Contents/MacOS/Chromium";
		const edge =
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
		const resolved = resolveChromeExecutable(
			{},
			(p) => p === chromium || p === edge,
		);
		expect(resolved).toBe(chromium);
		expect(DEFAULT_CHROME_PATHS.indexOf(chromium)).toBeLessThan(
			DEFAULT_CHROME_PATHS.indexOf(edge),
		);
	});

	it("names $DBG_CHROME as the escape hatch when nothing is found", () => {
		expect(() => resolveChromeExecutable({}, () => false)).toThrow(
			/\$DBG_CHROME/,
		);
	});
});

describe("parseDevToolsActivePort", () => {
	it("parses the port from the first line", () => {
		expect(parseDevToolsActivePort("12345\n/devtools/browser/abc")).toBe(12345);
	});

	it("rejects malformed content", () => {
		expect(() => parseDevToolsActivePort("")).toThrow(/invalid/);
		expect(() => parseDevToolsActivePort("not-a-port\n")).toThrow(/invalid/);
		expect(() => parseDevToolsActivePort("0\n")).toThrow(/invalid/);
		expect(() => parseDevToolsActivePort("-5\n")).toThrow(/invalid/);
	});
});

describe("pollDevToolsActivePort", () => {
	it("returns the port once the file appears", async () => {
		let calls = 0;
		const read = () => {
			calls++;
			return calls < 3 ? null : "9222\n/devtools/browser/xyz";
		};
		const port = await pollDevToolsActivePort(read, {
			timeoutMs: 1000,
			intervalMs: 1,
		});
		expect(port).toBe(9222);
		expect(calls).toBe(3);
	});

	it("retries past partial writes", async () => {
		let calls = 0;
		const read = () => {
			calls++;
			return calls < 2 ? "" : "8888\n";
		};
		const port = await pollDevToolsActivePort(read, {
			timeoutMs: 1000,
			intervalMs: 1,
		});
		expect(port).toBe(8888);
	});

	it("times out when the file never appears", async () => {
		await expect(
			pollDevToolsActivePort(() => null, { timeoutMs: 30, intervalMs: 5 }),
		).rejects.toThrow(/timed out/);
	});

	it("aborts early when the browser process dies", async () => {
		await expect(
			pollDevToolsActivePort(() => null, {
				timeoutMs: 5000,
				intervalMs: 5,
				isDead: () => true,
			}),
		).rejects.toThrow(/Chrome exited/);
	});
});

describe("cleanStaleSingletonLock", () => {
	function makeProfile(lockTarget?: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-profile-"));
		if (lockTarget !== undefined) {
			fs.symlinkSync(lockTarget, path.join(dir, "SingletonLock"));
			fs.symlinkSync("cookie", path.join(dir, "SingletonCookie"));
		}
		return dir;
	}

	it("is a no-op without a lock", () => {
		const dir = makeProfile();
		expect(cleanStaleSingletonLock(dir)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("removes a stale lock from a dead pid", () => {
		const dir = makeProfile(`${os.hostname()}-99999`);
		expect(cleanStaleSingletonLock(dir, () => false)).toBe(false);
		expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "SingletonCookie"))).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the lock and reports in-use when the owner is alive", () => {
		const dir = makeProfile(`${os.hostname()}-${process.pid}`);
		expect(cleanStaleSingletonLock(dir, () => true)).toBe(true);
		expect(fs.lstatSync(path.join(dir, "SingletonLock")).isSymbolicLink()).toBe(
			true,
		);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("removes a lock from a different host", () => {
		const dir = makeProfile("other-host.local-123");
		expect(cleanStaleSingletonLock(dir, () => true)).toBe(false);
		expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
