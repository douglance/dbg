// `this` binding table — shows this context per frame

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

export const thisTable: VirtualTable = {
	name: "this",
	columns: ["frame_id", "type", "value", "object_id"],
	async fetch(where, executor) {
		const state = executor.getState();
		const frameFilter = extractFilterValue(where, "frame_id");
		const rows: unknown[][] = [];

		const start = frameFilter !== null ? Number(frameFilter) : 0;
		const end =
			frameFilter !== null ? Number(frameFilter) + 1 : state.callFrames.length;

		for (let fi = start; fi < end && fi < state.callFrames.length; fi++) {
			const frame = state.callFrames[fi];
			if (!frame.thisObjectId) {
				rows.push([fi, "undefined", "undefined", ""]);
				continue;
			}

			const result = (await executor.send("Runtime.getProperties", {
				objectId: frame.thisObjectId,
				ownProperties: true,
			})) as { result: Array<{ name: string }> };

			const propNames = result.result.map((p) => p.name).slice(0, 5);
			const preview = `{${propNames.join(", ")}${result.result.length > 5 ? ", ..." : ""}}`;

			rows.push([fi, "object", preview, frame.thisObjectId]);
		}

		return { columns: this.columns, rows };
	},
};
