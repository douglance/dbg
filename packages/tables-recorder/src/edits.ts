// Recorder edits table — reads the raw file-edit stream from the event
// store's `edits` SQLite table. Each row is one fs-watch event captured
// during recording (id, ts epoch-ms, path, epoch_id, session_id).

import type { VirtualTable } from "@dbg/query";

export const editsTable: VirtualTable = {
	name: "edits",
	columns: ["id", "ts", "path", "epoch_id", "session_id"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, path, epoch_id, session_id
			 FROM edits
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [row.id, row.ts, row.path, row.epoch_id, row.session_id]);

		return { columns: this.columns, rows };
	},
};
