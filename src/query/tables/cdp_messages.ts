import type { CdpExecutor } from "../../protocol.js";
import type { VirtualTable } from "./index.js";

const COLUMNS = [
	"id",
	"ts",
	"direction",
	"method",
	"latency_ms",
	"error",
	"data",
];

export const cdpTable: VirtualTable = {
	name: "cdp",
	columns: COLUMNS,
	async fetch(_where, executor) {
		return fetchCdpRows(this.columns, executor);
	},
};

export const cdpMessagesTable: VirtualTable = {
	name: "cdp_messages",
	columns: COLUMNS,
	async fetch(_where, executor) {
		return fetchCdpRows(this.columns, executor);
	},
};

async function fetchCdpRows(
	columns: string[],
	executor: CdpExecutor,
): Promise<{ columns: string[]; rows: unknown[][] }> {
	const store = executor.getStore?.();
	if (!store) {
		return { columns, rows: [] };
	}

	const result = store.query(
		`SELECT
			id,
			ts,
			CASE
				WHEN source = 'cdp_send' THEN 'send'
				WHEN source = 'cdp_recv' THEN 'recv'
				ELSE source
			END AS direction,
			method,
			json_extract(data, '$.latencyMs') AS latency_ms,
			json_extract(data, '$.error') AS error,
			data
		 FROM events
		 WHERE category = 'cdp'
		 ORDER BY id DESC
		 LIMIT 1000`,
	);

	const rows = result
		.reverse()
		.map((row) => [
			row.id,
			row.ts,
			row.direction,
			row.method,
			row.latency_ms,
			row.error,
			row.data,
		]);

	return { columns, rows };
}
