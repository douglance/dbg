import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const XCRUN_BINARY = process.env.XCRUN_PATH?.trim() || "xcrun";
const LOG_BINARY = process.env.LOG_PATH?.trim() || "log";

interface DevicectlPayload<T> {
	info?: {
		outcome?: string;
	};
	result?: T;
}

interface DeviceResult {
	devices?: DeviceRecord[];
}

interface AppsResult {
	apps?: AppRecord[];
}

interface ProcessesResult {
	runningProcesses?: ProcessRecord[];
}

interface LaunchProcessResult {
	process?: {
		processIdentifier?: number;
		executable?: string;
	};
}

export interface DeviceRecord {
	identifier: string;
	hardwareProperties?: {
		platform?: string;
		udid?: string;
	};
	deviceProperties?: {
		name?: string;
		bootState?: string;
	};
}

export interface AppRecord {
	bundleIdentifier: string;
	name: string;
	url: string;
}

export interface ProcessRecord {
	processIdentifier: number;
	executable: string;
}

export function listDevices(): DeviceRecord[] {
	const result = runDevicectlJson<DeviceResult>(["list", "devices"]);
	return result.devices ?? [];
}

export function listApps(device: string): AppRecord[] {
	const result = runDevicectlJson<AppsResult>([
		"device",
		"info",
		"apps",
		"--device",
		device,
	]);
	return result.apps ?? [];
}

export function listProcesses(device: string): ProcessRecord[] {
	const result = runDevicectlJson<ProcessesResult>([
		"device",
		"info",
		"processes",
		"--device",
		device,
	]);
	return result.runningProcesses ?? [];
}

export function launchProcess(
	device: string,
	bundleId: string,
	options?: {
		args?: string[];
		startStopped?: boolean;
		terminateExisting?: boolean;
	},
): { pid: number | null; executable?: string } {
	const normalizedBundleId = bundleId.trim();
	if (!normalizedBundleId) {
		throw new Error("bundleId is required");
	}
	const args = options?.args ?? [];
	const cmd: string[] = [
		"device",
		"process",
		"launch",
		"--device",
		device,
		...(options?.startStopped ? ["--start-stopped"] : []),
		...(options?.terminateExisting ? ["--terminate-existing"] : []),
		normalizedBundleId,
		...args,
	];
	const result = runDevicectlJson<LaunchProcessResult>(cmd);
	const rawPid = result.process?.processIdentifier;
	const pid = typeof rawPid === "number" ? rawPid : null;
	const executable = result.process?.executable;
	if (pid === null || !Number.isInteger(pid) || pid <= 0) {
		return { pid: null, executable };
	}
	return { pid, executable };
}

export function discoverDebugProxyPort(deviceId: string): number {
	const normalizedDeviceId = deviceId.trim();
	if (!normalizedDeviceId) {
		throw new Error("deviceId is required to discover debugproxy port");
	}

	const predicateDeviceId = normalizedDeviceId.replace(/"/g, '\\"');
	let logs = "";
	try {
		logs = execFileSync(
			LOG_BINARY,
			[
				"show",
				"--style",
				"compact",
				"--last",
				"15m",
				"--predicate",
				`eventMessage CONTAINS[c] "debugproxy" AND eventMessage CONTAINS[c] "${predicateDeviceId}"`,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		throw new Error(
			`failed to read system logs for debugproxy port discovery: ${normalizeErrorMessage(error)}`,
		);
	}

	const port = parseDebugProxyPort(logs);
	if (port !== null) {
		return port;
	}

	throw new Error(
		[
			`unable to discover debugproxy port for device ${normalizedDeviceId}`,
			`gdb-remote attach requires a CoreDevice debugproxy (look for 'debugproxy listening on tcp:<port>' in system logs)`,
		].join("; "),
	);
}

function runDevicectlJson<T>(args: string[]): T {
	const jsonPath = path.join(
		os.tmpdir(),
		`dbg-devicectl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);

	try {
		execFileSync(
			XCRUN_BINARY,
			["devicectl", ...args, "--json-output", jsonPath],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		throw new Error(
			`devicectl ${args.join(" ")} failed: ${normalizeErrorMessage(error)}`,
		);
	}

	let payloadText = "";
	try {
		payloadText = fs.readFileSync(jsonPath, "utf8");
	} catch {
		throw new Error(`devicectl ${args.join(" ")} did not produce JSON output`);
	} finally {
		try {
			fs.unlinkSync(jsonPath);
		} catch {
			// ignore temporary file cleanup failures
		}
	}

	let payload: DevicectlPayload<T>;
	try {
		payload = JSON.parse(payloadText) as DevicectlPayload<T>;
	} catch {
		throw new Error(`devicectl ${args.join(" ")} produced invalid JSON output`);
	}

	if (payload.info?.outcome !== "success") {
		throw new Error(
			`devicectl ${args.join(" ")} returned outcome '${payload.info?.outcome ?? "unknown"}'`,
		);
	}
	if (!payload.result) {
		throw new Error(`devicectl ${args.join(" ")} returned no result payload`);
	}

	return payload.result;
}

function normalizeErrorMessage(error: unknown): string {
	const err = error as { stderr?: string | Buffer; message?: string };
	if (typeof err.stderr === "string") {
		return collapseWhitespace(err.stderr);
	}
	if (Buffer.isBuffer(err.stderr)) {
		return collapseWhitespace(err.stderr.toString("utf8"));
	}
	if (typeof err.message === "string") {
		return collapseWhitespace(err.message);
	}
	return "unknown error";
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function parseDebugProxyPort(logText: string): number | null {
	const lines = logText
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.reverse();

	for (const line of lines) {
		if (!line.toLowerCase().includes("debugproxy")) {
			continue;
		}

		const explicitMatch = line.match(/\b(?:port|tcp)\D{0,12}(\d{2,5})\b/i);
		const candidateText = explicitMatch?.[1];
		if (!candidateText) {
			continue;
		}
		const candidatePort = Number.parseInt(candidateText, 10);
		if (
			Number.isInteger(candidatePort) &&
			candidatePort > 0 &&
			candidatePort <= 65535
		) {
			return candidatePort;
		}
	}

	return null;
}
