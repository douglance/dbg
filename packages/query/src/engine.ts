import type { DebugExecutor } from "@dbg/types";

import { filterRows, limitRows, orderRows } from "./filter.js";
import { parseQuery } from "./parser.js";
import { getDefaultRegistry, type QueryRegistry } from "./registry.js";

export async function executeQuery(
	queryString: string,
	executor: DebugExecutor,
	registry: QueryRegistry = getDefaultRegistry(),
): Promise<{ columns: string[]; rows: unknown[][]; format: "tsv" | "json" }> {
	let format: "tsv" | "json" = "tsv";
	let sql = queryString.trim();
	if (sql.endsWith("\\j")) {
		format = "json";
		sql = sql.slice(0, -2).trim();
	}
	const query = parseQuery(sql);

	const table = registry.getTable(query.table, executor.protocol);
	if (!table) {
		if (registry.getTable(query.table)) {
			throw new Error(
				`Table '${query.table}' is not available for ${executor.protocol} sessions`,
			);
		}
		throw new Error(`Unknown table: '${query.table}'`);
	}

	if (table.requiredFilters && table.requiredFilters.length > 0) {
		for (const required of table.requiredFilters) {
			if (!hasFilter(query.where, required)) {
				throw new Error(
					`Table '${query.table}' requires WHERE ${required}=...`,
				);
			}
		}
	}

	const result = await table.fetch(query.where, executor);
	let rows = filterRows(result.columns, result.rows, query.where);

	if (query.orderBy) {
		rows = orderRows(result.columns, rows, query.orderBy);
	}

	if (query.limit !== null) {
		rows = limitRows(rows, query.limit);
	}

	if (query.columns !== "*") {
		const indices = query.columns.map((col) => {
			const idx = result.columns.indexOf(col);
			if (idx === -1) {
				throw new Error(`Unknown column '${col}' in table '${query.table}'`);
			}
			return idx;
		});
		rows = rows.map((row) => indices.map((i) => row[i]));
		return { columns: query.columns, rows, format };
	}

	return { columns: result.columns, rows, format };
}

function hasFilter(
	where: import("./parser.js").WhereExpr | null,
	column: string,
): boolean {
	if (!where) return false;
	switch (where.type) {
		case "comparison":
			return where.column === column && where.op === "=";
		case "and":
			return hasFilter(where.left, column) || hasFilter(where.right, column);
		case "or":
			return hasFilter(where.left, column) || hasFilter(where.right, column);
		case "paren":
			return hasFilter(where.expr, column);
	}
}
