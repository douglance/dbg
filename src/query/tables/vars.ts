// Variables table — fetches properties from scope objects via CDP

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

function formatValue(
	prop: { value?: { type?: string; subtype?: string; className?: string; description?: string; value?: unknown }; name: string },
): { type: string; display: string; objectId: string } {
	const val = prop.value;
	if (!val) return { type: "undefined", display: "undefined", objectId: "" };

	const objectId = (val as { objectId?: string }).objectId ?? "";

	if (val.type === "object") {
		if (val.subtype === "null") return { type: "null", display: "null", objectId };
		if (val.subtype === "array") {
			const desc = val.description ?? "Array";
			return { type: "array", display: `[${desc}]`, objectId };
		}
		return { type: "object", display: `[${val.className ?? "Object"}]`, objectId };
	}

	if (val.type === "function") {
		const name = val.description?.split("(")[0]?.replace("function ", "") ?? prop.name;
		return { type: "function", display: `[Function: ${name}]`, objectId };
	}

	return { type: val.type ?? "unknown", display: String(val.value ?? val.description ?? ""), objectId };
}

export const varsTable: VirtualTable = {
	name: "vars",
	columns: ["frame_id", "scope", "name", "type", "value", "object_id"],
	async fetch(where, executor) {
		const state = executor.getState();
		const frameFilter = extractFilterValue(where, "frame_id");
		const frameId = frameFilter !== null ? Number(frameFilter) : 0;

		if (frameId < 0 || frameId >= state.callFrames.length) {
			return { columns: this.columns, rows: [] };
		}

		const frame = state.callFrames[frameId];
		const rows: unknown[][] = [];

		for (const scope of frame.scopeChain) {
			// Skip global scope unless specifically asked for
			if (scope.type === "global") continue;

			const result = await executor.send("Runtime.getProperties", {
				objectId: scope.objectId,
				ownProperties: true,
			}) as { result: Array<{ name: string; value?: unknown }> };

			for (const prop of result.result) {
				const formatted = formatValue(prop as Parameters<typeof formatValue>[0]);
				rows.push([
					frameId,
					scope.type,
					prop.name,
					formatted.type,
					formatted.display,
					formatted.objectId,
				]);
			}
		}

		return { columns: this.columns, rows };
	},
};
