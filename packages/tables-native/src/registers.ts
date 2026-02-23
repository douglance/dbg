import type { VirtualTable } from "@dbg/query";
import { assertDapQueryable } from "./utils.js";

export const registersTable: VirtualTable = {
	name: "registers",
	columns: ["group", "name", "value"],
	async fetch(_where, executor) {
		const state = executor.getState();
		assertDapQueryable(state);
		const dapState = state.dap;
		const rows: unknown[][] = [];

		if (dapState?.registers && dapState.registers.length > 0) {
			for (const group of dapState.registers) {
				for (const reg of group.registers) {
					rows.push([group.name, reg.name, reg.value]);
				}
			}
			return { columns: this.columns, rows };
		}

		let response: {
			registers?: Array<{ group?: string; name: string; value: string }>;
		};
		try {
			response = (await executor.send("registers", {
				threadId: dapState?.threadId ?? undefined,
			})) as typeof response;
		} catch (error) {
			const msg =
				error instanceof Error ? error.message.toLowerCase() : "";
			if (
				msg.includes("transport") ||
				msg.includes("closed") ||
				msg.includes("exited")
			) {
				throw new Error(
					"registers unavailable: debug adapter disconnected (physical device sessions may not support register reads)",
				);
			}
			throw error;
		}

		for (const reg of response.registers ?? []) {
			rows.push([reg.group ?? "general", reg.name, reg.value]);
		}
		return { columns: this.columns, rows };
	},
};
