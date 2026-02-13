// Network headers table — parses JSON headers from NetworkRequest
// Requires WHERE request_id=...

import type { VirtualTable } from "@dbg/query";
import { extractFilterValue } from "./utils.js";

export const networkHeadersTable: VirtualTable = {
	name: "network_headers",
	columns: ["request_id", "direction", "name", "value"],
	requiredFilters: ["request_id"],
	async fetch(where, executor) {
		const requestId = extractFilterValue(where, "request_id");
		if (!requestId) {
			return { columns: this.columns, rows: [] };
		}

		const state = executor.getState();
		const req = state.cdp?.networkRequests.get(String(requestId));
		if (!req) {
			return { columns: this.columns, rows: [] };
		}

		const rows: unknown[][] = [];
		// Parse request headers
		if (req.requestHeaders) {
			try {
				const headers = JSON.parse(req.requestHeaders) as Record<
					string,
					string
				>;
				for (const [name, value] of Object.entries(headers)) {
					rows.push([req.id, "request", name, value]);
				}
			} catch {
				// malformed JSON, skip
			}
		}
		// Parse response headers
		if (req.responseHeaders) {
			try {
				const headers = JSON.parse(req.responseHeaders) as Record<
					string,
					string
				>;
				for (const [name, value] of Object.entries(headers)) {
					rows.push([req.id, "response", name, value]);
				}
			} catch {
				// malformed JSON, skip
			}
		}

		return { columns: this.columns, rows };
	},
};
