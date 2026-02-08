import { vi } from "vitest";
import type { CdpExecutor, DaemonState } from "../src/protocol.js";

export function createState(overrides: Partial<DaemonState> = {}): DaemonState {
	return {
		connected: false,
		paused: false,
		pid: null,
		managedCommand: null,
		lastWsUrl: null,
		callFrames: [],
		asyncStackTrace: [],
		breakpoints: new Map(),
		scripts: new Map(),
		console: [],
		exceptions: [],
		...overrides,
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
		executor: { send, getState },
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
