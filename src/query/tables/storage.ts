// Web storage table — fetches localStorage or sessionStorage entries
// Requires WHERE type='local' or type='session'

import type { VirtualTable } from "./index.js";
import { extractFilterValue } from "./utils.js";

export const storageTable: VirtualTable = {
	name: "storage",
	columns: ["type", "key", "value"],
	requiredFilters: ["type"],
	async fetch(where, executor) {
		const storageType = extractFilterValue(where, "type");
		if (
			!storageType ||
			(storageType !== "local" && storageType !== "session")
		) {
			return { columns: this.columns, rows: [] };
		}

		try {
			const storageObj =
				storageType === "local" ? "localStorage" : "sessionStorage";
			const result = (await executor.send("Runtime.evaluate", {
				expression: `JSON.stringify(Object.entries(${storageObj}).map(([k,v]) => ({k,v})))`,
				returnByValue: true,
			})) as { result: { value?: string } };

			if (!result.result.value) {
				return { columns: this.columns, rows: [] };
			}

			const entries = JSON.parse(result.result.value) as Array<{
				k: string;
				v: string;
			}>;
			const rows: unknown[][] = entries.map((e) => [
				String(storageType),
				e.k,
				e.v,
			]);

			return { columns: this.columns, rows };
		} catch {
			return { columns: this.columns, rows: [] };
		}
	},
};
