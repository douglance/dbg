// Event listeners table — fetches via DOMDebugger.getEventListeners
// Requires WHERE object_id=...

import type { WhereExpr } from "../parser.js";
import type { VirtualTable } from "./index.js";

function extractFilterValue(
	where: WhereExpr | null,
	column: string,
): string | number | null {
	if (!where) return null;
	switch (where.type) {
		case "comparison":
			if (where.column === column && where.op === "=") return where.value;
			return null;
		case "and":
			return (
				extractFilterValue(where.left, column) ??
				extractFilterValue(where.right, column)
			);
		case "or":
			return null;
		case "paren":
			return extractFilterValue(where.expr, column);
	}
}

export const listenersTable: VirtualTable = {
	name: "listeners",
	columns: ["object_id", "type", "handler", "once", "use_capture"],
	requiredFilters: ["object_id"],
	async fetch(where, executor) {
		const objectId = extractFilterValue(where, "object_id");
		if (!objectId) {
			return { columns: this.columns, rows: [] };
		}

		const result = (await executor.send("DOMDebugger.getEventListeners", {
			objectId: String(objectId),
		})) as {
			listeners: Array<{
				type: string;
				handler?: { description?: string };
				once?: boolean;
				useCapture?: boolean;
			}>;
		};

		const rows: unknown[][] = result.listeners.map((listener) => [
			String(objectId),
			listener.type,
			listener.handler?.description ?? "",
			listener.once ?? false,
			listener.useCapture ?? false,
		]);

		return { columns: this.columns, rows };
	},
};
