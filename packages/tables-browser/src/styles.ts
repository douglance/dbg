// Computed styles table — fetches computed CSS styles for a node
// Requires WHERE node_id=...

import type { VirtualTable } from "@dbg/query";
import { extractFilterValue } from "./utils.js";

export const stylesTable: VirtualTable = {
	name: "styles",
	columns: ["node_id", "name", "value"],
	requiredFilters: ["node_id"],
	async fetch(where, executor) {
		const nodeId = extractFilterValue(where, "node_id");
		if (!nodeId) {
			return { columns: this.columns, rows: [] };
		}

		try {
			const result = (await executor.send("CSS.getComputedStyleForNode", {
				nodeId: Number(nodeId),
			})) as {
				computedStyle: Array<{ name: string; value: string }>;
			};

			const rows: unknown[][] = result.computedStyle.map((prop) => [
				Number(nodeId),
				prop.name,
				prop.value,
			]);

			return { columns: this.columns, rows };
		} catch {
			return { columns: this.columns, rows: [] };
		}
	},
};
