// Console messages table — reads from daemon state

import type { VirtualTable } from "@dbg/query";

export const consoleTable: VirtualTable = {
	name: "console",
	columns: ["id", "type", "text", "ts", "stack"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = state.console.map((entry) => [
			entry.id,
			entry.type,
			entry.text,
			entry.ts,
			entry.stack,
		]);
		return { columns: this.columns, rows };
	},
};
