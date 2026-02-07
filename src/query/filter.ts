// In-memory filtering, ordering, and limiting for query results

import type { WhereExpr } from "./parser.js";

export function filterRows(
	columns: string[],
	rows: unknown[][],
	where: WhereExpr | null,
): unknown[][] {
	if (!where) return rows;
	return rows.filter((row) => evaluateExpr(columns, row, where));
}

export function orderRows(
	columns: string[],
	rows: unknown[][],
	orderBy: { column: string; direction: "ASC" | "DESC" },
): unknown[][] {
	const idx = columns.indexOf(orderBy.column);
	if (idx === -1) return rows;

	const sorted = [...rows];
	const dir = orderBy.direction === "ASC" ? 1 : -1;

	sorted.sort((a, b) => {
		const av = a[idx];
		const bv = b[idx];

		// numeric comparison if both are numeric
		const an = Number(av);
		const bn = Number(bv);
		if (!Number.isNaN(an) && !Number.isNaN(bn)) {
			return (an - bn) * dir;
		}

		// string comparison
		const as = String(av ?? "");
		const bs = String(bv ?? "");
		if (as < bs) return -1 * dir;
		if (as > bs) return 1 * dir;
		return 0;
	});

	return sorted;
}

export function limitRows(rows: unknown[][], limit: number): unknown[][] {
	return rows.slice(0, limit);
}

function evaluateExpr(
	columns: string[],
	row: unknown[],
	expr: WhereExpr,
): boolean {
	switch (expr.type) {
		case "comparison":
			return evaluateComparison(columns, row, expr);
		case "and":
			return (
				evaluateExpr(columns, row, expr.left) &&
				evaluateExpr(columns, row, expr.right)
			);
		case "or":
			return (
				evaluateExpr(columns, row, expr.left) ||
				evaluateExpr(columns, row, expr.right)
			);
		case "paren":
			return evaluateExpr(columns, row, expr.expr);
	}
}

function evaluateComparison(
	columns: string[],
	row: unknown[],
	expr: { type: "comparison"; column: string; op: string; value: string | number },
): boolean {
	const idx = columns.indexOf(expr.column);
	if (idx === -1) return false;

	const cellValue = row[idx];
	const filterValue = expr.value;

	if (expr.op === "LIKE") {
		const pattern = String(filterValue)
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/%/g, ".*");
		const regex = new RegExp(`^${pattern}$`, "i");
		return regex.test(String(cellValue ?? ""));
	}

	// numeric comparison if both sides parse as numbers
	const cellStr = String(cellValue ?? "");
	const cellNum = Number(cellValue);
	const filterNum = Number(filterValue);
	const cellIsNumeric = cellStr !== "" && !Number.isNaN(cellNum);
	const filterIsNumeric = typeof filterValue === "number" || (String(filterValue) !== "" && !Number.isNaN(filterNum));

	if (cellIsNumeric && filterIsNumeric) {
		switch (expr.op) {
			case "=":
				return cellNum === filterNum;
			case "!=":
				return cellNum !== filterNum;
			case "<":
				return cellNum < filterNum;
			case ">":
				return cellNum > filterNum;
			case "<=":
				return cellNum <= filterNum;
			case ">=":
				return cellNum >= filterNum;
		}
	}

	// If filter is numeric but cell isn't, ordering comparisons don't match
	if (filterIsNumeric && !cellIsNumeric) {
		switch (expr.op) {
			case "=":
				return false;
			case "!=":
				return true;
			default:
				return false;
		}
	}

	// string comparison
	const fs = String(filterValue);
	switch (expr.op) {
		case "=":
			return cellStr === fs;
		case "!=":
			return cellStr !== fs;
		case "<":
			return cellStr < fs;
		case ">":
			return cellStr > fs;
		case "<=":
			return cellStr <= fs;
		case ">=":
			return cellStr >= fs;
	}

	return false;
}
