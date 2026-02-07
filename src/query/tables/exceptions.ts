// Exceptions table — reads from daemon state

import type { VirtualTable } from "./index.js";

export const exceptionsTable: VirtualTable = {
	name: "exceptions",
	columns: ["id", "text", "type", "file", "line", "ts", "uncaught"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = state.exceptions.map((entry) => [
			entry.id,
			entry.text,
			entry.type,
			entry.file,
			entry.line,
			entry.ts,
			entry.uncaught,
		]);
		return { columns: this.columns, rows };
	},
};
