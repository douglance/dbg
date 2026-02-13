import { vi } from "vitest";
import {
	CDP_CAPABILITIES,
	type CdpState,
	type CdpExecutor,
	type DaemonState,
	type DapState,
} from "../packages/types/src/index.js";

type StateOverrides = Omit<Partial<DaemonState>, "cdp" | "dap"> & {
	cdp?: Partial<CdpState>;
	dap?: Partial<DapState>;
};

export function createState(overrides: StateOverrides = {}): DaemonState {
	const { cdp: cdpOverrides, dap: dapOverrides, ...rest } = overrides;
	const defaultCdp: CdpState = {
		lastWsUrl: null,
		networkRequests: new Map(),
		pageEvents: [],
		wsFrames: [],
		coverageSnapshot: null,
	};
	const defaultDap: DapState = {
		threadId: null,
		activeThreads: [],
		registers: [],
		modules: [],
		targetTriple: "",
	};

	return {
		connected: false,
		paused: false,
		pid: null,
		managedCommand: null,
		callFrames: [],
		asyncStackTrace: [],
		breakpoints: new Map(),
		scripts: new Map(),
		console: [],
		exceptions: [],
		cdp: {
			...defaultCdp,
			...(cdpOverrides ?? {}),
		},
		dap: {
			...defaultDap,
			...(dapOverrides ?? {}),
		},
		...rest,
	};
}

export function createExecutor(
	state: DaemonState,
	sendImpl?: (method: string, params?: Record<string, unknown>) => unknown,
): {
	executor: CdpExecutor;
	send: ReturnType<typeof vi.fn>;
	getState: ReturnType<typeof vi.fn>;
} {
	const send = vi.fn(
		async (method: string, params?: Record<string, unknown>) => {
			if (!sendImpl) return {};
			return sendImpl(method, params);
		},
	);
	const getState = vi.fn(() => state);
	return {
		executor: {
			send,
			getState,
			protocol: "cdp",
			capabilities: CDP_CAPABILITIES,
		},
		send,
		getState,
	};
}

export function createMockCdp() {
	return {
		send: vi.fn(async () => ({})),
		waitForPaused: vi.fn(async () => {}),
	};
}
