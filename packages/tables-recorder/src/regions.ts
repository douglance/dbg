// Recorder regions table — reads component-blame regions (dbg after) from
// the event store's `regions` SQLite table.

import type { VirtualTable } from "@dbg/query";

export const regionsTable: VirtualTable = {
	name: "regions",
	columns: ["id", "diff_id", "x", "y", "w", "h", "component", "file", "causal"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, diff_id, x, y, w, h, component, file, causal
			 FROM regions
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [
				row.id,
				row.diff_id,
				row.x,
				row.y,
				row.w,
				row.h,
				row.component,
				row.file,
				row.causal,
			]);

		return { columns: this.columns, rows };
	},
};
