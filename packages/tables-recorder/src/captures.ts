// Recorder captures table — reads screenshot capture metadata from the
// event store's `captures` SQLite table.
//
// Named `captures` (not `frames`) because the registry already has a
// `frames` table for stack frames in @dbg/tables-core.

import type { VirtualTable } from "@dbg/query";

export const capturesTable: VirtualTable = {
	name: "captures",
	columns: [
		"id",
		"ts",
		"session_id",
		"url",
		"scroll_y",
		"dpr",
		"hash",
		"png_path",
		"changed_files",
		"hmr_modules",
		"epoch_id",
		"snapshot_path",
		"tier",
	],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, session_id, url, scroll_y, dpr, hash, png_path, changed_files, hmr_modules, epoch_id, snapshot_path, tier
			 FROM captures
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [
				row.id,
				row.ts,
				row.session_id,
				row.url,
				row.scroll_y,
				row.dpr,
				row.hash,
				row.png_path,
				row.changed_files,
				row.hmr_modules,
				row.epoch_id,
				row.snapshot_path,
				row.tier,
			]);

		return { columns: this.columns, rows };
	},
};
