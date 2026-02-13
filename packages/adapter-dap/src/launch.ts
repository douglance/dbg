import { execFileSync, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { accessSync } from "node:fs";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface LldbLaunchOptions {
	lldbDapPath?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export function resolveLldbDapBinary(options: LldbLaunchOptions = {}): string {
	const explicit = options.lldbDapPath?.trim();
	if (explicit) {
		if (!isExecutable(explicit)) {
			throw new Error(`lldb-dap not executable: ${explicit}`);
		}
		return explicit;
	}

	const envPath = process.env.LLDB_DAP_PATH?.trim();
	if (envPath) {
		if (!isExecutable(envPath)) {
			throw new Error(`LLDB_DAP_PATH is not executable: ${envPath}`);
		}
		return envPath;
	}

	const xcrunPath = findViaXcrun();
	if (xcrunPath) {
		return xcrunPath;
	}

	for (const candidate of [
		"/Library/Developer/CommandLineTools/usr/bin/lldb-dap",
		"/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap",
	]) {
		if (isExecutable(candidate)) {
			return candidate;
		}
	}

	if (isCommandOnPath("lldb-dap")) {
		return "lldb-dap";
	}

	throw new Error(
		"unable to locate lldb-dap; set LLDB_DAP_PATH or install Xcode/Command Line Tools",
	);
}

export function launchLldbDap(
	options: LldbLaunchOptions = {},
): ChildProcessWithoutNullStreams {
	const binary = resolveLldbDapBinary(options);
	const child = spawn(binary, [], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	return child;
}

function findViaXcrun(): string | null {
	try {
		const out = execFileSync("xcrun", ["--find", "lldb-dap"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (out && isExecutable(out)) {
			return out;
		}
	} catch {
		// xcrun unavailable or lldb-dap not found there
	}
	return null;
}

function isCommandOnPath(command: string): boolean {
	const locator = process.platform === "win32" ? "where" : "which";
	try {
		execFileSync(locator, [command], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function isExecutable(filePath: string): boolean {
	try {
		accessSync(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}
