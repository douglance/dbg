import { DapClientWrapper, type LldbAttachToPidOptions } from "@dbg/adapter-dap";
import { DAP_CAPABILITIES } from "@dbg/types";
import type {
	DebuggerState,
	EventStoreLike,
	SessionCapabilities,
} from "@dbg/types";

import {
	resolveVisionOsProcess,
	type ResolvedVisionOsProcess,
	type VisionOsProcessResolutionOptions,
} from "./simctl.js";

export type VisionOsAttachOptions = VisionOsProcessResolutionOptions &
	Omit<LldbAttachToPidOptions, "pid">;

export class VisionOsClientWrapper {
	readonly protocol = "dap" as const;
	readonly capabilities: SessionCapabilities = DAP_CAPABILITIES;

	private readonly dap: DapClientWrapper;

	constructor(state: DebuggerState, store?: EventStoreLike | null) {
		this.dap = new DapClientWrapper(state, store);
	}

	getState(): DebuggerState {
		return this.dap.getState();
	}

	getStore(): EventStoreLike | null {
		return this.dap.getStore();
	}

	async connect(target: string, targetType?: "node" | "page"): Promise<void> {
		return this.dap.connect(target, targetType);
	}

	async disconnect(): Promise<void> {
		return this.dap.disconnect();
	}

	async waitForPaused(timeoutMs?: number): Promise<void> {
		return this.dap.waitForPaused(timeoutMs);
	}

	async send(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		return this.dap.send(method, params);
	}

	async attachVisionOs(
		options: VisionOsAttachOptions,
	): Promise<ResolvedVisionOsProcess> {
		const resolved = resolveVisionOsProcess(options);
		await this.dap.attachLldbToPid({
			pid: resolved.pid,
			waitFor: options.waitFor,
			cwd: options.cwd,
			env: options.env,
			lldbDapPath: options.lldbDapPath,
		});
		return resolved;
	}
}

export {
	parseLaunchPid,
	parsePsPid,
	resolveVisionOsProcess,
	type ResolvedVisionOsProcess,
	type VisionOsProcessResolutionOptions,
} from "./simctl.js";
