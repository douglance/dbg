// Recorder epochs table — reads epoch markers from the event store's
// `epochs` SQLite table.

import type { VirtualTable } from "@dbg/query";

export const epochsTable: VirtualTable = {
	name: "epochs",
	columns: ["id", "ts", "session_id", "name", "auto"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, session_id, name, auto
			 FROM epochs
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [row.id, row.ts, row.session_id, row.name, row.auto]);

		return { columns: this.columns, rows };
	},
};
