import { execFileSync } from "node:child_process";

import type { AttachPlatform } from "@dbg/types";

const XCRUN_BINARY = process.env.XCRUN_PATH?.trim() || "xcrun";

interface SimctlListDevicesPayload {
	devices?: Record<string, SimctlDeviceRecord[] | undefined>;
}

interface SimctlDeviceRecord {
	udid: string;
	name: string;
	isAvailable?: boolean;
	state?: string;
}

export interface SimulatorDeviceRecord {
	identifier: string;
	name: string;
	state: string;
	isAvailable: boolean;
	platform: Exclude<AttachPlatform, "auto">;
	runtime: string;
}

export interface SimulatorProcessRecord {
	pid: number;
	command: string;
}

export function listSimulatorDevices(): SimulatorDeviceRecord[] {
	const payload = runSimctlJson<SimctlListDevicesPayload>(["list", "devices"]);
	const out: SimulatorDeviceRecord[] = [];
	for (const [runtime, devices] of Object.entries(payload.devices ?? {})) {
		const platform = platformFromRuntime(runtime);
		if (!platform) continue;
		for (const entry of devices ?? []) {
			out.push({
				identifier: entry.udid,
				name: entry.name,
				state: (entry.state ?? "").toLowerCase(),
				isAvailable: entry.isAvailable !== false,
				platform,
				runtime,
			});
		}
	}
	return out;
}

export function getSimulatorAppContainer(
	device: string,
	bundleId: string,
): string | null {
	const normalizedBundleId = bundleId.trim();
	if (!normalizedBundleId) return null;
	try {
		return runSimctl([
			"get_app_container",
			device,
			normalizedBundleId,
			"app",
		]).trim();
	} catch {
		return null;
	}
}

export function listSimulatorProcesses(
	device: string,
): SimulatorProcessRecord[] {
	const psOutput = runSimctl(["spawn", device, "ps", "-axo", "pid=,command="]);
	return psOutput
		.split(/\r?\n/)
		.map((rawLine) => rawLine.trim())
		.filter(Boolean)
		.map((line) => {
			const match = line.match(/^(\d+)\s+(.+)$/);
			if (!match) return null;
			const pid = Number.parseInt(match[1], 10);
			if (!Number.isInteger(pid) || pid <= 0) return null;
			return {
				pid,
				command: match[2],
			};
		})
		.filter((entry): entry is SimulatorProcessRecord => Boolean(entry));
}

export function launchSimulatorApp(
	device: string,
	bundleId: string,
): number | null {
	const output = runSimctl(["launch", device, bundleId]);
	return parseLaunchPid(output);
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

function runSimctlJson<T>(args: string[]): T {
	const output = runSimctl([...args, "--json"]);
	try {
		return JSON.parse(output) as T;
	} catch {
		throw new Error(`simctl ${args.join(" ")} returned invalid JSON output`);
	}
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
		const detail = collapseWhitespace(
			stderrText || err.message || "unknown error",
		);
		throw new Error(`simctl ${args.join(" ")} failed: ${detail}`);
	}
}

function platformFromRuntime(
	runtime: string,
): Exclude<AttachPlatform, "auto"> | null {
	if (/\.visionOS-/i.test(runtime)) return "visionos";
	if (/\.iOS-/i.test(runtime)) return "ios";
	if (/\.tvOS-/i.test(runtime)) return "tvos";
	if (/\.watchOS-/i.test(runtime)) return "watchos";
	return null;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
