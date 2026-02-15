import { DapClientWrapper } from "@dbg/adapter-dap";
import { discoverDebugProxyPort } from "@dbg/provider-apple-device";
import type {
	AttachDiagnostics,
	AttachRequest,
	AttachStrategy,
	DebuggerState,
	EventStoreLike,
	ProviderResolutionResult,
} from "@dbg/types";

const DEFAULT_ATTACH_TIMEOUT_MS = 45000;

export interface ExecuteAttachWithStrategyOptions {
	request: AttachRequest;
	resolution: ProviderResolutionResult;
	state: DebuggerState;
	store?: EventStoreLike | null;
	providerResolveMs?: number;
	discoverDebugProxyPort?: (deviceId: string) => number;
	createDapClient?: (
		state: DebuggerState,
		store?: EventStoreLike | null,
	) => DapClientWrapper;
}

export interface AttachAttemptResult {
	success: boolean;
	dap: DapClientWrapper;
	strategy: AttachStrategy;
	diagnostics: AttachDiagnostics;
	error?: string;
}

export async function executeAttachWithStrategy(
	options: ExecuteAttachWithStrategyOptions,
): Promise<AttachAttemptResult> {
	const requestedStrategy = options.request.attachStrategy ?? "auto";
	const strategyOrder = resolveStrategyOrder(
		requestedStrategy,
		isSimulatorResolution(options.resolution),
	);
	const providerResolveMs = Math.max(0, options.providerResolveMs ?? 0);
	const attachTimeoutMs = normalizeAttachTimeoutMs(
		options.request.attachTimeoutMs,
	);
	const createDapClient =
		options.createDapClient ??
		((state: DebuggerState, store?: EventStoreLike | null) =>
			new DapClientWrapper(state, store));
	const discoverPort = options.discoverDebugProxyPort ?? discoverDebugProxyPort;

	const diagnostics: AttachDiagnostics = {
		requestedStrategy,
		attemptedStrategies: [],
		selectedStrategy: null,
		providerResolveMs,
		totalMs: 0,
	};

	const attachStartedAt = Date.now();
	let lastErrorMessage = "attach failed";
	let lastDap: DapClientWrapper | null = null;

	for (const strategy of strategyOrder) {
		const attemptStartedAt = Date.now();
		const dap = createDapClient(options.state, options.store);
		lastDap = dap;
		try {
			await runAttachStrategy({
				strategy,
				dap,
				resolution: options.resolution,
				attachTimeoutMs,
				discoverPort,
			});
			validateStopStateHandshake(options.state);
			options.state.pid = options.resolution.pid;

			diagnostics.attemptedStrategies.push({
				strategy,
				durationMs: Date.now() - attemptStartedAt,
				success: true,
			});
			diagnostics.selectedStrategy = strategy;
			diagnostics.totalMs = providerResolveMs + (Date.now() - attachStartedAt);

			return {
				success: true,
				dap,
				strategy,
				diagnostics,
			};
		} catch (error) {
			lastErrorMessage = errorMessage(error);
			diagnostics.attemptedStrategies.push({
				strategy,
				durationMs: Date.now() - attemptStartedAt,
				success: false,
				error: lastErrorMessage,
			});
			await safeDisconnect(dap);
			resetStateAfterFailedAttach(options.state);
		}
	}

	diagnostics.totalMs = providerResolveMs + (Date.now() - attachStartedAt);
	return {
		success: false,
		dap:
			lastDap ??
			(options.createDapClient
				? options.createDapClient(options.state, options.store)
				: new DapClientWrapper(options.state, options.store)),
		strategy: requestedStrategy,
		diagnostics,
		error: lastErrorMessage,
	};
}

export function resolveStrategyOrder(
	requested: AttachStrategy,
	isSimulatorTarget = false,
): Array<"device-process" | "gdb-remote"> {
	if (isSimulatorTarget) {
		if (requested === "gdb-remote") {
			return ["gdb-remote"];
		}
		return ["device-process"];
	}
	switch (requested) {
		case "auto":
			return ["device-process", "gdb-remote"];
		case "device-process":
			return ["device-process"];
		case "gdb-remote":
			return ["gdb-remote"];
	}
}

export function validateStopStateHandshake(state: DebuggerState): void {
	if (!state.paused) {
		throw new Error("attach handshake failed: debugger is not paused");
	}
	if (!state.dap || state.dap.activeThreads.length < 1) {
		throw new Error("attach handshake failed: no active dap threads");
	}
	if (state.callFrames.length < 1) {
		throw new Error("attach handshake failed: no call frames available");
	}
}

interface RunAttachStrategyOptions {
	strategy: "device-process" | "gdb-remote";
	dap: DapClientWrapper;
	resolution: ProviderResolutionResult;
	attachTimeoutMs: number;
	discoverPort: (deviceId: string) => number;
}

async function runAttachStrategy(
	options: RunAttachStrategyOptions,
): Promise<void> {
	const simulatorTarget = isSimulatorResolution(options.resolution);
	if (options.strategy === "device-process") {
		if (simulatorTarget) {
			await options.dap.attachLldbToPid({
				pid: options.resolution.pid,
				waitFor: false,
				requestTimeoutMs: options.attachTimeoutMs,
			});
			return;
		}
		await options.dap.attachLldbToPid({
			pid: options.resolution.pid,
			waitFor: false,
			attachCommands: [
				`device select ${options.resolution.deviceId}`,
				`device process attach --pid ${options.resolution.pid}`,
			],
			requestTimeoutMs: options.attachTimeoutMs,
		});
		return;
	}
	if (simulatorTarget) {
		throw new Error("gdb-remote attach is only supported for physical devices");
	}

	const port = options.discoverPort(options.resolution.deviceId);
	await options.dap.attachLldbGdbRemote({
		gdbRemotePort: port,
		pid: options.resolution.pid,
		requestTimeoutMs: options.attachTimeoutMs,
	});
}

function normalizeAttachTimeoutMs(value: number | undefined): number {
	if (!value || !Number.isFinite(value)) {
		return DEFAULT_ATTACH_TIMEOUT_MS;
	}
	if (value <= 0) {
		return DEFAULT_ATTACH_TIMEOUT_MS;
	}
	return Math.round(value);
}

async function safeDisconnect(dap: DapClientWrapper): Promise<void> {
	try {
		await dap.disconnect();
	} catch {
		// ignore cleanup errors between strategy attempts
	}
}

function resetStateAfterFailedAttach(state: DebuggerState): void {
	state.connected = false;
	state.paused = false;
	state.pid = null;
	state.callFrames = [];
	state.asyncStackTrace = [];
	if (state.dap) {
		state.dap.threadId = null;
		state.dap.activeThreads = [];
		state.dap.modules = [];
		state.dap.registers = [];
		state.dap.targetTriple = "";
		state.dap.phase = "terminated";
		state.dap.lastStop = null;
		state.dap.lastError = null;
		state.dap.stopEpoch = 0;
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isSimulatorResolution(resolution: ProviderResolutionResult): boolean {
	return (
		String(resolution.metadata?.attachEnvironment ?? "").toLowerCase() ===
		"simulator"
	);
}
