// Recorder perf_samples table — PerformanceObserver batches + per-capture
// Performance.getMetrics / bundle_bytes samples, from the event store's
// `perf_samples` SQLite table.

import type { VirtualTable } from "@dbg/query";

export const perfSamplesTable: VirtualTable = {
	name: "perf_samples",
	columns: ["id", "ts", "nav_id", "capture_id", "metric", "value", "detail"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const result = store.query(
			`SELECT id, ts, nav_id, capture_id, metric, value, detail
			 FROM perf_samples
			 ORDER BY id DESC
			 LIMIT 1000`,
		);

		const rows = result
			.reverse()
			.map((row) => [
				row.id,
				row.ts,
				row.nav_id,
				row.capture_id,
				row.metric,
				row.value,
				row.detail,
			]);

		return { columns: this.columns, rows };
	},
};
