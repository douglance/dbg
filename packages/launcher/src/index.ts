// Managed Chrome launcher: resolve a Chrome-compatible executable, spawn it
// headless with a dedicated debugging profile, discover the ephemeral
// DevTools port from <profile>/DevToolsActivePort, and provide graceful
// SIGTERM→SIGKILL teardown.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Standard macOS locations, in preference order.
export const DEFAULT_CHROME_PATHS = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/Applications/Arc.app/Contents/MacOS/Arc",
];

export const DEFAULT_PROFILE_DIR = path.join(
	os.homedir(),
	".dbg",
	"chrome-profile",
);

/**
 * Resolve the Chrome executable to launch: $DBG_CHROME wins, then the first
 * installed browser from DEFAULT_CHROME_PATHS. Throws a descriptive error
 * naming $DBG_CHROME as the escape hatch when nothing is found.
 */
export function resolveChromeExecutable(
	env: Record<string, string | undefined> = process.env,
	exists: (p: string) => boolean = fs.existsSync,
): string {
	const override = env.DBG_CHROME?.trim();
	if (override) {
		if (!exists(override)) {
			throw new Error(
				`$DBG_CHROME points to a missing executable: ${override}`,
			);
		}
		return override;
	}
	for (const candidate of DEFAULT_CHROME_PATHS) {
		if (exists(candidate)) return candidate;
	}
	throw new Error(
		"no Chrome-compatible browser found (looked for Chrome, Chrome Canary, " +
			"Chromium, Edge, Brave, and Arc under /Applications). " +
			"Set $DBG_CHROME to a browser executable to override.",
	);
}

/**
 * Parse the contents of a DevToolsActivePort file. First line is the port;
 * throws on malformed/partial content so pollers can retry.
 */
export function parseDevToolsActivePort(content: string): number {
	const firstLine = content.split("\n")[0]?.trim() ?? "";
	const port = Number.parseInt(firstLine, 10);
	if (!Number.isInteger(port) || port <= 0 || String(port) !== firstLine) {
		throw new Error(
			`invalid DevToolsActivePort content: ${JSON.stringify(firstLine)}`,
		);
	}
	return port;
}

export interface PollOptions {
	timeoutMs?: number;
	intervalMs?: number;
	/** Abort early (e.g. the browser process already exited). */
	isDead?: () => boolean;
}

/**
 * Poll a DevToolsActivePort reader until it yields a valid port. `read`
 * returns the file content, or null while the file does not exist yet.
 */
export async function pollDevToolsActivePort(
	read: () => string | null,
	options: PollOptions = {},
): Promise<number> {
	const timeoutMs = options.timeoutMs ?? 10000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const content = read();
		if (content !== null) {
			try {
				return parseDevToolsActivePort(content);
			} catch {
				// partial write — keep polling
			}
		}
		if (options.isDead?.()) {
			throw new Error("Chrome exited before publishing DevToolsActivePort");
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`timed out after ${timeoutMs}ms waiting for DevToolsActivePort`,
			);
		}
		await sleep(intervalMs);
	}
}

/**
 * Chrome refuses to start ("ProcessSingleton" abort) when the profile holds a
 * SingletonLock left behind by a crashed/killed instance. The lock is a
 * symlink whose target is "<hostname>-<pid>"; remove it (and its siblings)
 * when the owning process is gone. Returns true if a live owner holds the
 * lock, in which case launching would abort.
 */
export function cleanStaleSingletonLock(
	profileDir: string,
	isLockOwner: (
		pid: number,
		profileDir: string,
	) => boolean = defaultIsLockOwner,
): boolean {
	const lockPath = path.join(profileDir, "SingletonLock");
	let target: string;
	try {
		target = fs.readlinkSync(lockPath);
	} catch {
		return false; // no lock — nothing to clean
	}

	const match = /-(\d+)$/.exec(target);
	const ownerPid = match ? Number.parseInt(match[1], 10) : Number.NaN;
	const ownerHost = match
		? target.slice(0, target.length - match[0].length)
		: target;
	if (
		Number.isInteger(ownerPid) &&
		ownerHost === os.hostname() &&
		isLockOwner(ownerPid, profileDir)
	) {
		return true; // live owner on this machine — do not steal the profile
	}

	for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
		try {
			fs.unlinkSync(path.join(profileDir, name));
		} catch {
			// already gone
		}
	}
	return false;
}

// A pid recorded in SingletonLock only counts as a live owner if the process
// still exists AND its command line references this profile dir — a plain
// liveness check gives false positives on pid reuse.
function defaultIsLockOwner(pid: number, profileDir: string): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			timeout: 3000,
		});
		return command.includes(profileDir);
	} catch {
		// can't inspect the process — err on the side of not clobbering it
		return true;
	}
}

export interface LaunchChromeOptions {
	/** Open a visible window instead of headless (for future --login). */
	headful?: boolean;
	/** Profile directory; defaults to ~/.dbg/chrome-profile (created). */
	profileDir?: string;
	/** Max wait for DevToolsActivePort to appear. Default 10000ms. */
	timeoutMs?: number;
	/** Environment for executable resolution. Default process.env. */
	env?: Record<string, string | undefined>;
}

export interface LaunchedChrome {
	pid: number;
	port: number;
	/** Graceful teardown: SIGTERM, then SIGKILL if still alive after 3s. */
	kill(): Promise<void>;
}

export async function launchChrome(
	options: LaunchChromeOptions = {},
): Promise<LaunchedChrome> {
	const executable = resolveChromeExecutable(options.env ?? process.env);
	const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
	fs.mkdirSync(profileDir, { recursive: true });

	if (cleanStaleSingletonLock(profileDir)) {
		throw new Error(
			`managed Chrome profile is in use by another Chrome instance (${profileDir}); stop it or pass a different profile directory`,
		);
	}

	// Remove a stale port file so we never read a previous run's port.
	const portFile = path.join(profileDir, "DevToolsActivePort");
	try {
		fs.unlinkSync(portFile);
	} catch {
		// doesn't exist, fine
	}

	const args = [
		...(options.headful ? [] : ["--headless"]),
		"--remote-debugging-port=0",
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--hide-scrollbars",
		"--mute-audio",
		"about:blank",
	];

	const child: ChildProcess = spawn(executable, args, { stdio: "ignore" });
	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	child.on("error", () => {
		exited = true;
	});

	const readPortFile = (): string | null => {
		try {
			return fs.readFileSync(portFile, "utf8");
		} catch {
			return null;
		}
	};

	let port: number;
	try {
		port = await pollDevToolsActivePort(readPortFile, {
			timeoutMs: options.timeoutMs ?? 10000,
			isDead: () => exited,
		});
	} catch (e) {
		if (!exited) {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
		throw e;
	}

	const pid = child.pid;
	if (pid === undefined) {
		throw new Error("Chrome spawned without a pid");
	}

	return {
		pid,
		port,
		async kill(): Promise<void> {
			if (exited) return;
			try {
				child.kill("SIGTERM");
			} catch {
				return;
			}
			const graceDeadline = Date.now() + 3000;
			while (!exited && Date.now() < graceDeadline) {
				await sleep(50);
			}
			if (exited) return;
			try {
				child.kill("SIGKILL");
			} catch {
				return;
			}
			const killDeadline = Date.now() + 2000;
			while (!exited && Date.now() < killDeadline) {
				await sleep(50);
			}
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
