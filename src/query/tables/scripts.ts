// Scripts table — reads from daemon state

import type { VirtualTable } from "./index.js";

export const scriptsTable: VirtualTable = {
	name: "scripts",
	columns: ["id", "file", "url", "lines", "source_map", "is_module"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = [];
		for (const script of state.scripts.values()) {
			rows.push([
				script.id,
				script.file,
				script.url,
				script.lines,
				script.sourceMap,
				script.isModule,
			]);
		}
		return { columns: this.columns, rows };
	},
};
