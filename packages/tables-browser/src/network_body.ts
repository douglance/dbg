// Network response body table — on-demand CDP call to fetch response body
// Requires WHERE request_id=...

import type { VirtualTable } from "@dbg/query";
import { extractFilterValue } from "./utils.js";

export const networkBodyTable: VirtualTable = {
	name: "network_body",
	columns: ["request_id", "body", "base64_encoded"],
	requiredFilters: ["request_id"],
	async fetch(where, executor) {
		const requestId = extractFilterValue(where, "request_id");
		if (!requestId) {
			return { columns: this.columns, rows: [] };
		}

		try {
			const result = (await executor.send("Network.getResponseBody", {
				requestId: String(requestId),
			})) as { body: string; base64Encoded: boolean };

			return {
				columns: this.columns,
				rows: [[String(requestId), result.body, result.base64Encoded]],
			};
		} catch {
			return { columns: this.columns, rows: [] };
		}
	},
};
