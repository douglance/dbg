// Recorder a11y_issues table — accessibility issues computed per capture,
// from the event store's `a11y_issues` SQLite table.

import type { VirtualTable } from "@dbg/query";

export const a11yIssuesTable: VirtualTable = {
	name: "a11y_issues",
	columns: ["id", "ts", "capture_id", "rule", "selector", "detail"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, capture_id, rule, selector, detail
			 FROM a11y_issues
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [
				row.id,
				row.ts,
				row.capture_id,
				row.rule,
				row.selector,
				row.detail,
			]);

		return { columns: this.columns, rows };
	},
};
