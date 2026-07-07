// Recorder diffs table — reads pixel-diff results (dbg after) from the
// event store's `diffs` SQLite table.

import type { VirtualTable } from "@dbg/query";

export const diffsTable: VirtualTable = {
	name: "diffs",
	columns: [
		"id",
		"ts",
		"name",
		"baseline_capture_id",
		"after_capture_id",
		"diff_percent",
		"diff_pixels",
		"report_path",
	],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, name, baseline_capture_id, after_capture_id, diff_percent, diff_pixels, report_path
			 FROM diffs
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [
				row.id,
				row.ts,
				row.name,
				row.baseline_capture_id,
				row.after_capture_id,
				row.diff_percent,
				row.diff_pixels,
				row.report_path,
			]);

		return { columns: this.columns, rows };
	},
};
