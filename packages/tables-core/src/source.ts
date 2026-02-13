// Source code lines table — lazy loaded via Debugger.getScriptSource
// Requires WHERE file= or script_id=

import type { WhereExpr } from "@dbg/query";
import type { VirtualTable } from "@dbg/query";

interface FilterMatch {
	value: string | number;
	op: string;
}

function extractFilter(
	where: WhereExpr | null,
	column: string,
): FilterMatch | null {
	if (!where) return null;
	switch (where.type) {
		case "comparison":
			if (where.column === column && (where.op === "=" || where.op === "LIKE"))
				return { value: where.value, op: where.op };
			return null;
		case "and":
			return (
				extractFilter(where.left, column) ?? extractFilter(where.right, column)
			);
		case "or":
			return null;
		case "paren":
			return extractFilter(where.expr, column);
	}
}

function matchesLike(value: string, pattern: string): boolean {
	const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(
		`^${escaped.replace(/%/g, ".*").replace(/_/g, ".")}$`,
		"i",
	);
	return regex.test(value);
}

export const sourceTable: VirtualTable = {
	name: "source",
	columns: ["script_id", "file", "line", "text"],
	async fetch(where, executor) {
		const state = executor.getState();

		const scriptIdFilter = extractFilter(where, "script_id");
		const fileFilter = extractFilter(where, "file");

		if (!scriptIdFilter && !fileFilter) {
			throw new Error(
				"Table 'source' requires WHERE file=... or script_id=...",
			);
		}

		let scriptId: string | number | null = scriptIdFilter?.value ?? null;

		// If file is given, look up script_id by matching
		if (!scriptId && fileFilter) {
			const pattern = String(fileFilter.value);
			for (const script of state.scripts.values()) {
				const matches =
					fileFilter.op === "LIKE"
						? matchesLike(script.file, pattern)
						: script.file === pattern;
				if (matches) {
					scriptId = script.id;
					break;
				}
			}
			if (!scriptId) {
				return { columns: this.columns, rows: [] };
			}
		}

		if (!scriptId) {
			return { columns: this.columns, rows: [] };
		}

		const script = state.scripts.get(String(scriptId));
		const file = script?.file ?? "";

		const result = (await executor.send("Debugger.getScriptSource", {
			scriptId: String(scriptId),
		})) as { scriptSource: string };

		const lines = result.scriptSource.split("\n");
		const rows: unknown[][] = lines.map((text, i) => [
			String(scriptId),
			file,
			i + 1,
			text,
		]);

		return { columns: this.columns, rows };
	},
};
