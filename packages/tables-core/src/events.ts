import type { VirtualTable } from "@dbg/query";

export const eventsTable: VirtualTable = {
	name: "events",
	columns: ["id", "ts", "source", "category", "method", "data", "session_id"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, source, category, method, data, session_id
			 FROM events
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [
				row.id,
				row.ts,
				row.source,
				row.category,
				row.method,
				row.data,
				row.session_id,
			]);

		return { columns: this.columns, rows };
	},
};
