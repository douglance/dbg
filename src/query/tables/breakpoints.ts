// Breakpoints table — reads from daemon state

import type { VirtualTable } from "./index.js";

export const breakpointsTable: VirtualTable = {
	name: "breakpoints",
	columns: ["id", "file", "line", "condition", "hits", "enabled"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = [];
		for (const bp of state.breakpoints.values()) {
			rows.push([bp.id, bp.file, bp.line, bp.condition, bp.hits, bp.enabled]);
		}
		return { columns: this.columns, rows };
	},
};
