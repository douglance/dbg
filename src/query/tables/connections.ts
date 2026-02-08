import type { VirtualTable } from "./index.js";

export const connectionsTable: VirtualTable = {
	name: "connections",
	columns: ["id", "ts", "event", "session_id", "data"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, method AS event, session_id, data
			 FROM events
			 WHERE category = 'connection'
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [row.id, row.ts, row.event, row.session_id, row.data]);

		return { columns: this.columns, rows };
	},
};
