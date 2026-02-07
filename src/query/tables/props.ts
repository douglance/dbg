// Object properties table — drills into an object via Runtime.getProperties
// Requires WHERE object_id=...

import type { VirtualTable } from "./index.js";
import type { WhereExpr } from "../parser.js";

function extractFilterValue(where: WhereExpr | null, column: string): string | number | null {
	if (!where) return null;
	switch (where.type) {
		case "comparison":
			if (where.column === column && where.op === "=") return where.value;
			return null;
		case "and":
			return extractFilterValue(where.left, column) ?? extractFilterValue(where.right, column);
		case "or":
			return null;
		case "paren":
			return extractFilterValue(where.expr, column);
	}
}

export const propsTable: VirtualTable = {
	name: "props",
	columns: ["object_id", "name", "type", "value", "writable", "configurable", "enumerable", "child_id"],
	requiredFilters: ["object_id"],
	async fetch(where, executor) {
		const objectId = extractFilterValue(where, "object_id");
		if (!objectId) {
			return { columns: this.columns, rows: [] };
		}

		const result = await executor.send("Runtime.getProperties", {
			objectId: String(objectId),
			ownProperties: true,
		}) as {
			result: Array<{
				name: string;
				writable?: boolean;
				configurable?: boolean;
				enumerable?: boolean;
				value?: {
					type?: string;
					subtype?: string;
					className?: string;
					description?: string;
					value?: unknown;
					objectId?: string;
				};
			}>;
		};

		const rows: unknown[][] = result.result.map((prop) => {
			const val = prop.value;
			let type = "undefined";
			let display = "undefined";
			let childId = "";

			if (val) {
				type = val.subtype ?? val.type ?? "unknown";
				if (val.type === "object" && val.subtype !== "null") {
					display = val.description ?? `[${val.className ?? "Object"}]`;
					childId = val.objectId ?? "";
				} else if (val.type === "function") {
					display = `[Function: ${prop.name}]`;
					childId = val.objectId ?? "";
				} else {
					display = String(val.value ?? val.description ?? "");
				}
			}

			return [
				String(objectId),
				prop.name,
				type,
				display,
				prop.writable ?? false,
				prop.configurable ?? false,
				prop.enumerable ?? false,
				childId,
			];
		});

		return { columns: this.columns, rows };
	},
};
