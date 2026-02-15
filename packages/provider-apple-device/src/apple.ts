import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AttachPlatform,
	AttachRequest,
	ProviderResolutionResult,
} from "@dbg/types";

import { APPLE_DEVICE_PROVIDER } from "./contracts.js";
import {
	type AppRecord,
	type DeviceRecord,
	type ProcessRecord,
	launchProcess,
	listApps,
	listDevices,
	listProcesses,
} from "./devicectl.js";
import { AppleDeviceProviderError } from "./errors.js";
import {
	getSimulatorAppContainer,
	launchSimulatorApp,
	listSimulatorDevices,
	listSimulatorProcesses,
	type SimulatorDeviceRecord,
	type SimulatorProcessRecord,
} from "./simctl.js";

type ResolvedAttachPlatform = Exclude<AttachPlatform, "auto">;

const XCRUN_BINARY = process.env.XCRUN_PATH?.trim() || "xcrun";
let cachedXcrunFailure: string | null = null;
let cachedXcrunChecked = false;

interface PhysicalCandidate {
	kind: "device";
	identifier: string;
	name: string;
	platform: ResolvedAttachPlatform;
	booted: boolean;
	device: DeviceRecord;
}

interface SimulatorCandidate {
	kind: "simulator";
	identifier: string;
	name: string;
	platform: ResolvedAttachPlatform;
	booted: boolean;
	sim: SimulatorDeviceRecord;
}

type AttachCandidate = PhysicalCandidate | SimulatorCandidate;

export interface AppleAttachTargetInfo {
	kind: "device" | "simulator";
	platform: ResolvedAttachPlatform;
	booted: boolean;
	identifier: string;
	udid?: string;
	name: string;
	runtime?: string;
}

export function listAppleAttachTargets(
	platform: AttachPlatform = "auto",
): AppleAttachTargetInfo[] {
	assertAppleHost();
	const physical = listPhysicalCandidates(platform);
	const simulators = listSimulatorCandidates(platform);
	const sorted = sortCandidates([...physical, ...simulators]);
	return sorted.map((candidate) => {
		if (candidate.kind === "device") {
			return {
				kind: "device",
				platform: candidate.platform,
				booted: candidate.booted,
				identifier: candidate.identifier,
				udid: candidate.device.hardwareProperties?.udid ?? "",
				name: candidate.name,
			};
		}
		return {
			kind: "simulator",
			platform: candidate.platform,
			booted: candidate.booted,
			identifier: candidate.identifier,
			name: candidate.name,
			runtime: candidate.sim.runtime,
		};
	});
}

export function resolveAppleAttachTarget(
	request: AttachRequest,
): ProviderResolutionResult {
	assertAppleHost();
	if (request.provider !== APPLE_DEVICE_PROVIDER) {
		throw new AppleDeviceProviderError(
			"invalid_request",
			`unsupported provider: ${request.provider}`,
		);
	}
	if (!request.bundleId.trim()) {
		throw new AppleDeviceProviderError(
			"invalid_request",
			"bundleId is required",
		);
	}

	const requestedPlatform = normalizeRequestedPlatform(request.platform);
	const candidates = resolveCandidates(requestedPlatform, request.device);
	if (candidates.length === 0) {
		throw new AppleDeviceProviderError(
			"device_not_found",
			buildNoDeviceMessage(requestedPlatform),
		);
	}

	const errors: AppleDeviceProviderError[] = [];
	for (const candidate of candidates) {
		try {
			if (candidate.kind === "device") {
				return resolvePhysicalCandidate(candidate, request);
			}
			return resolveSimulatorCandidate(candidate, request);
		} catch (error) {
			if (error instanceof AppleDeviceProviderError) {
				errors.push(error);
				continue;
			}
			throw error;
		}
	}

	const processError = errors.find(
		(error) => error.code === "process_not_running",
	);
	if (processError) throw processError;
	const appError = errors.find((error) => error.code === "app_not_installed");
	if (appError) throw appError;
	const firstError = errors[0];
	if (firstError) throw firstError;

	throw new AppleDeviceProviderError(
		"provider_error",
		"failed to resolve attach target",
	);
}

function assertAppleHost(): void {
	if (process.platform !== "darwin") {
		throw new AppleDeviceProviderError(
			"invalid_request",
			"apple-device provider requires macOS",
		);
	}

	if (!cachedXcrunChecked) {
		cachedXcrunChecked = true;
		try {
			execFileSync(XCRUN_BINARY, ["--version"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			cachedXcrunFailure = null;
		} catch (error) {
			cachedXcrunFailure = normalizeErrorMessage(error);
		}
	}

	if (cachedXcrunFailure) {
		throw new AppleDeviceProviderError(
			"invalid_request",
			"apple-device provider requires Xcode command line tools (xcrun)",
			{ error: cachedXcrunFailure },
		);
	}
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

function resolvePhysicalCandidate(
	candidate: PhysicalCandidate,
	request: AttachRequest,
): ProviderResolutionResult {
	const apps = listApps(candidate.identifier);
	const app = apps.find((entry) => entry.bundleIdentifier === request.bundleId);
	if (!app) {
		throw new AppleDeviceProviderError(
			"app_not_installed",
			`app '${request.bundleId}' is not installed on device ${candidate.identifier}`,
			{
				device: candidate.identifier,
				platform: candidate.platform,
			},
		);
	}

	let processes = listProcesses(candidate.identifier);
	let selectedPid: ReturnType<typeof resolvePhysicalProcessId>;
	try {
		selectedPid = resolvePhysicalProcessId(processes, app, request.pid);
	} catch (error) {
		if (
			request.pid === undefined &&
			request.launch &&
			error instanceof AppleDeviceProviderError &&
			error.code === "process_not_running"
		) {
			const launched = launchProcess(candidate.identifier, request.bundleId, {
				terminateExisting: false,
				startStopped: false,
			});
			if (launched.pid !== null) {
				processes = listProcesses(candidate.identifier);
				selectedPid = resolvePhysicalProcessId(processes, app, launched.pid);
			} else {
				processes = listProcesses(candidate.identifier);
				selectedPid = resolvePhysicalProcessId(processes, app, request.pid);
			}
		} else {
			throw error;
		}
	}

	return {
		provider: APPLE_DEVICE_PROVIDER,
		platform: candidate.platform,
		deviceId: candidate.identifier,
		bundleId: request.bundleId,
		pid: selectedPid.pid,
		attachProtocol: "dap",
		metadata: {
			attachEnvironment: "device",
			deviceName: candidate.name,
			appName: app.name,
			executable: selectedPid.executable,
			matchedBy: selectedPid.matchKind,
		},
	};
}

function resolveSimulatorCandidate(
	candidate: SimulatorCandidate,
	request: AttachRequest,
): ProviderResolutionResult {
	const appContainer = getSimulatorAppContainer(
		candidate.identifier,
		request.bundleId,
	);
	if (!appContainer) {
		throw new AppleDeviceProviderError(
			"app_not_installed",
			`app '${request.bundleId}' is not installed on simulator ${candidate.identifier}`,
			{
				device: candidate.identifier,
				platform: candidate.platform,
			},
		);
	}

	const processes = listSimulatorProcesses(candidate.identifier);
	const selectedPid = resolveSimulatorProcessId({
		processes,
		bundleId: request.bundleId,
		appContainer,
		overridePid: request.pid,
	});

	let pid = selectedPid.pid;
	let matchedBy = selectedPid.matchKind;
	if (pid === null && request.launch) {
		const launchedPid = launchSimulatorApp(
			candidate.identifier,
			request.bundleId,
		);
		if (launchedPid !== null) {
			pid = launchedPid;
			matchedBy = "launch";
		}
	}

	if (pid === null) {
		throw new AppleDeviceProviderError(
			"process_not_running",
			`no running process found for app '${request.bundleId}' on simulator ${candidate.identifier}`,
			{
				bundleId: request.bundleId,
				device: candidate.identifier,
				suggestedCommand: `xcrun simctl launch ${candidate.identifier} ${request.bundleId}`,
			},
		);
	}

	return {
		provider: APPLE_DEVICE_PROVIDER,
		platform: candidate.platform,
		deviceId: candidate.identifier,
		bundleId: request.bundleId,
		pid,
		attachProtocol: "dap",
		metadata: {
			attachEnvironment: "simulator",
			deviceName: candidate.name,
			appContainer,
			matchedBy,
		},
	};
}

function resolveCandidates(
	platform: AttachPlatform,
	override: string | undefined,
): AttachCandidate[] {
	const physical = listPhysicalCandidates(platform);
	const simulators = listSimulatorCandidates(platform);
	const all = [...physical, ...simulators];

	if (override?.trim()) {
		const parsed = parseDeviceOverride(override);
		const matched = all.filter((candidate) =>
			matchesCandidateIdentifier(candidate, parsed.needle),
		);
		const scoped =
			parsed.scope === "sim"
				? matched.filter((candidate) => candidate.kind === "simulator")
				: parsed.scope === "device"
					? matched.filter((candidate) => candidate.kind === "device")
					: matched;
		if (scoped.length === 0) {
			throw new AppleDeviceProviderError(
				"device_not_found",
				`device or simulator '${override.trim()}' not found`,
				{
					availableDevices: all.map((candidate) => ({
						identifier: candidate.identifier,
						name: candidate.name,
						kind: candidate.kind,
						platform: candidate.platform,
						booted: candidate.booted,
					})),
				},
			);
		}
		return sortCandidates(scoped);
	}

	const booted = all.filter((candidate) => candidate.booted);
	if (booted.length > 0) {
		return sortCandidates(booted);
	}
	return sortCandidates(all);
}

function listPhysicalCandidates(platform: AttachPlatform): PhysicalCandidate[] {
	try {
		return listDevices()
			.map((device) => {
				const normalizedPlatform = normalizeResolvedPlatform(
					device.hardwareProperties?.platform,
				);
				if (!normalizedPlatform) return null;
				if (platform !== "auto" && normalizedPlatform !== platform) {
					return null;
				}
				return {
					kind: "device" as const,
					identifier: device.identifier,
					name: device.deviceProperties?.name ?? device.identifier,
					platform: normalizedPlatform,
					booted:
						(device.deviceProperties?.bootState ?? "").toLowerCase() ===
						"booted",
					device,
				};
			})
			.filter((candidate): candidate is PhysicalCandidate =>
				Boolean(candidate),
			);
	} catch {
		return [];
	}
}

function listSimulatorCandidates(
	platform: AttachPlatform,
): SimulatorCandidate[] {
	try {
		return listSimulatorDevices()
			.filter((sim) => sim.isAvailable)
			.filter((sim) => (platform === "auto" ? true : sim.platform === platform))
			.map((sim) => ({
				kind: "simulator" as const,
				identifier: sim.identifier,
				name: sim.name,
				platform: sim.platform,
				booted: sim.state === "booted",
				sim,
			}));
	} catch {
		return [];
	}
}

function sortCandidates(candidates: AttachCandidate[]): AttachCandidate[] {
	return [...candidates].sort((left, right) => {
		if (left.booted !== right.booted) {
			return left.booted ? -1 : 1;
		}
		if (left.kind !== right.kind) {
			return left.kind === "device" ? -1 : 1;
		}
		const nameCmp = left.name.localeCompare(right.name);
		if (nameCmp !== 0) return nameCmp;
		return left.identifier.localeCompare(right.identifier);
	});
}

function matchesCandidateIdentifier(
	candidate: AttachCandidate,
	needle: string,
): boolean {
	return (
		candidate.identifier === needle ||
		candidate.name === needle ||
		(candidate.kind === "device" &&
			(candidate.device.hardwareProperties?.udid ?? "") === needle)
	);
}

function resolvePhysicalProcessId(
	processes: ProcessRecord[],
	app: AppRecord,
	overridePid?: number,
): {
	pid: number;
	executable: string;
	matchKind: "pid" | "app_path" | "app_name";
} {
	if (overridePid !== undefined) {
		const pid = Number(overridePid);
		if (!Number.isInteger(pid) || pid <= 0) {
			throw new AppleDeviceProviderError(
				"invalid_request",
				"pid must be a positive integer",
			);
		}
		const proc = processes.find((entry) => entry.processIdentifier === pid);
		if (!proc) {
			throw new AppleDeviceProviderError(
				"process_not_running",
				`process pid ${pid} is not running on target device`,
				{ pid },
			);
		}
		return {
			pid,
			executable: decodePathLike(proc.executable),
			matchKind: "pid",
		};
	}

	const appDir = normalizeAppDirectory(app.url);
	const pathMatches = processes
		.map((entry) => ({
			pid: entry.processIdentifier,
			executable: decodePathLike(entry.executable),
		}))
		.filter((entry) => entry.executable.startsWith(`${appDir}/`))
		.sort((left, right) => right.pid - left.pid);
	if (pathMatches.length > 0) {
		return {
			pid: pathMatches[0].pid,
			executable: pathMatches[0].executable,
			matchKind: "app_path",
		};
	}

	const appNameNeedle = `${app.name}.app/`;
	const nameMatches = processes
		.map((entry) => ({
			pid: entry.processIdentifier,
			executable: decodePathLike(entry.executable),
		}))
		.filter((entry) => entry.executable.includes(appNameNeedle))
		.sort((left, right) => right.pid - left.pid);
	if (nameMatches.length > 0) {
		return {
			pid: nameMatches[0].pid,
			executable: nameMatches[0].executable,
			matchKind: "app_name",
		};
	}

	throw new AppleDeviceProviderError(
		"process_not_running",
		`no running process found for app '${app.bundleIdentifier}'`,
		{
			bundleId: app.bundleIdentifier,
			suggestedCommand: `xcrun devicectl device process launch --device <device-id> ${app.bundleIdentifier}`,
		},
	);
}

function resolveSimulatorProcessId(options: {
	processes: SimulatorProcessRecord[];
	bundleId: string;
	appContainer: string;
	overridePid?: number;
}): {
	pid: number | null;
	matchKind: "pid" | "bundle_id" | "app_container" | "app_name" | "launch";
} {
	if (options.overridePid !== undefined) {
		const pid = Number(options.overridePid);
		if (!Number.isInteger(pid) || pid <= 0) {
			throw new AppleDeviceProviderError(
				"invalid_request",
				"pid must be a positive integer",
			);
		}
		const match = options.processes.find((process) => process.pid === pid);
		if (!match) {
			throw new AppleDeviceProviderError(
				"process_not_running",
				`process pid ${pid} is not running on target simulator`,
				{ pid },
			);
		}
		return { pid, matchKind: "pid" };
	}

	const appContainerPath = decodePathLike(options.appContainer);
	const appName = path.basename(appContainerPath).replace(/\.app$/i, "");
	const bundleMatch = options.processes
		.filter((process) => process.command.includes(options.bundleId))
		.sort((left, right) => right.pid - left.pid)[0];
	if (bundleMatch) {
		return { pid: bundleMatch.pid, matchKind: "bundle_id" };
	}

	const containerMatch = options.processes
		.filter((process) => process.command.includes(appContainerPath))
		.sort((left, right) => right.pid - left.pid)[0];
	if (containerMatch) {
		return { pid: containerMatch.pid, matchKind: "app_container" };
	}

	const nameNeedle = `${appName}.app/`;
	const nameMatch = options.processes
		.filter((process) => process.command.includes(nameNeedle))
		.sort((left, right) => right.pid - left.pid)[0];
	if (nameMatch) {
		return { pid: nameMatch.pid, matchKind: "app_name" };
	}

	return { pid: null, matchKind: "bundle_id" };
}

function normalizeRequestedPlatform(
	platform: AttachPlatform | undefined,
): AttachPlatform {
	if (!platform) {
		return "auto";
	}
	return platform;
}

function normalizeResolvedPlatform(
	platform: string | undefined,
): ResolvedAttachPlatform | null {
	const normalized = (platform ?? "").trim().toLowerCase();
	if (!normalized) return null;
	if (normalized.includes("vision")) return "visionos";
	if (normalized.includes("watch")) return "watchos";
	if (normalized.includes("tv")) return "tvos";
	if (normalized.includes("ios")) return "ios";
	return null;
}

function normalizeAppDirectory(appUrl: string): string {
	const decoded = decodePathLike(appUrl);
	return decoded.replace(/\/$/, "");
}

function decodePathLike(value: string): string {
	if (!value.startsWith("file://")) {
		return value;
	}
	try {
		return fileURLToPath(value);
	} catch {
		return value.replace(/^file:\/\//, "");
	}
}

function buildNoDeviceMessage(platform: AttachPlatform): string {
	if (platform === "auto") {
		return "no booted Apple devices or simulators found";
	}
	return `no booted ${platform} devices or simulators found`;
}

function parseDeviceOverride(raw: string): {
	scope: "any" | "sim" | "device";
	needle: string;
} {
	const trimmed = raw.trim();
	if (trimmed.toLowerCase().startsWith("sim:")) {
		return { scope: "sim", needle: trimmed.slice(4) };
	}
	if (
		trimmed.toLowerCase().startsWith("device:") ||
		trimmed.toLowerCase().startsWith("dev:")
	) {
		const idx = trimmed.indexOf(":");
		return { scope: "device", needle: trimmed.slice(idx + 1) };
	}
	return { scope: "any", needle: trimmed };
}
