import type { VirtualTable } from "@dbg/query";
import { assertDapQueryable } from "./utils.js";

export const threadsTable: VirtualTable = {
	name: "threads",
	columns: ["id", "name"],
	async fetch(_where, executor) {
		const state = executor.getState();
		assertDapQueryable(state);
		if (state.dap?.activeThreads?.length) {
			return {
				columns: this.columns,
				rows: state.dap.activeThreads.map((thread) => [thread.id, thread.name]),
			};
		}

		const response = (await executor.send("threads")) as {
			threads?: Array<{ id: number; name: string }>;
		};

		return {
			columns: this.columns,
			rows: (response.threads ?? []).map((thread) => [thread.id, thread.name]),
		};
	},
};
