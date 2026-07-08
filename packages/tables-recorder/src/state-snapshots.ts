// Recorder state_snapshots table — per-capture local/sessionStorage dumps
// from the event store's `state_snapshots` SQLite table.

import type { VirtualTable } from "@dbg/query";

export const stateSnapshotsTable: VirtualTable = {
	name: "state_snapshots",
	columns: ["id", "ts", "capture_id", "kind", "data"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, capture_id, kind, data
			 FROM state_snapshots
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [row.id, row.ts, row.capture_id, row.kind, row.data]);

		return { columns: this.columns, rows };
	},
};
