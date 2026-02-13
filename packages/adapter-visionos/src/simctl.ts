import { execFileSync } from "node:child_process";

const XCRUN_BINARY = process.env.XCRUN_PATH?.trim() || "xcrun";

export interface VisionOsProcessResolutionOptions {
	bundleId: string;
	device?: string;
	pid?: number;
	launchArgs?: string[];
}

export interface ResolvedVisionOsProcess {
	bundleId: string;
	device: string;
	pid: number;
	launched: boolean;
}

export function resolveVisionOsProcess(
	options: VisionOsProcessResolutionOptions,
): ResolvedVisionOsProcess {
	const bundleId = options.bundleId.trim();
	if (!bundleId) {
		throw new Error("bundle id is required");
	}

	const device = options.device?.trim() || "booted";
	if (options.pid !== undefined) {
		const pid = Number(options.pid);
		if (!Number.isInteger(pid) || pid <= 0) {
			throw new Error("pid must be a positive integer");
		}
		return { bundleId, device, pid, launched: false };
	}

	const launchOutput = runSimctl(["launch", device, bundleId, ...(options.launchArgs ?? [])]);
	const launchPid = parseLaunchPid(launchOutput);
	if (launchPid !== null) {
		return { bundleId, device, pid: launchPid, launched: true };
	}

	const psOutput = runSimctl(["spawn", device, "ps", "-axo", "pid=,command="]);
	const existingPid = parsePsPid(psOutput, bundleId);
	if (existingPid !== null) {
		return { bundleId, device, pid: existingPid, launched: true };
	}

	throw new Error(
		`unable to resolve process pid for ${bundleId}; simctl output: ${collapseWhitespace(launchOutput)}`,
	);
}

export function parseLaunchPid(output: string): number | null {
	const colonMatch = output.match(/:\s*(\d+)\s*$/m);
	if (colonMatch) {
		return Number.parseInt(colonMatch[1], 10);
	}

	const pidMatch = output.match(/\bpid\b[^0-9]*(\d+)/i);
	if (pidMatch) {
		return Number.parseInt(pidMatch[1], 10);
	}

	const numbers = Array.from(output.matchAll(/\b(\d+)\b/g)).map((match) =>
		Number.parseInt(match[1], 10),
	);
	if (numbers.length === 1) {
		return numbers[0];
	}

	return null;
}

export function parsePsPid(output: string, bundleId: string): number | null {
	const normalizedBundleId = bundleId.trim();
	if (!normalizedBundleId) return null;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || !line.includes(normalizedBundleId)) {
			continue;
		}

		const pidMatch = line.match(/^(\d+)\s+/);
		if (!pidMatch) {
			continue;
		}

		const pid = Number.parseInt(pidMatch[1], 10);
		if (Number.isInteger(pid) && pid > 0) {
			return pid;
		}
	}

	return null;
}

function runSimctl(args: string[]): string {
	try {
		return String(
			execFileSync(XCRUN_BINARY, ["simctl", ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
	} catch (error) {
		const err = error as {
			message?: string;
			stderr?: string | Buffer;
		};
		const stderrText =
			typeof err.stderr === "string"
				? err.stderr
				: err.stderr
					? err.stderr.toString("utf8")
					: "";
		const detail = collapseWhitespace(stderrText || err.message || "unknown error");
		throw new Error(`simctl ${args.join(" ")} failed: ${detail}`);
	}
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
