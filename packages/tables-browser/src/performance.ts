// Performance metrics table — fetches runtime performance metrics
// No filter required

import type { VirtualTable } from "@dbg/query";

export const performanceTable: VirtualTable = {
	name: "performance",
	columns: ["name", "value"],
	async fetch(_where, executor) {
		try {
			const result = (await executor.send("Performance.getMetrics", {})) as {
				metrics: Array<{ name: string; value: number }>;
			};

			const rows: unknown[][] = result.metrics.map((m) => [m.name, m.value]);
			return { columns: this.columns, rows };
		} catch {
			return { columns: this.columns, rows: [] };
		}
	},
};
