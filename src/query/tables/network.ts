// Network requests table — reads accumulated state from networkRequests map

import type { VirtualTable } from "./index.js";

export const networkTable: VirtualTable = {
	name: "network",
	columns: [
		"id",
		"method",
		"url",
		"status",
		"type",
		"mime_type",
		"duration_ms",
		"size",
		"error",
		"initiator",
	],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = [];
		for (const req of state.networkRequests.values()) {
			rows.push([
				req.id,
				req.method,
				req.url,
				req.status,
				req.type,
				req.mimeType,
				req.duration,
				req.size,
				req.error,
				req.initiator,
			]);
		}
		return { columns: this.columns, rows };
	},
};
