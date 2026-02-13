// Shared utility for extracting filter values from WHERE clauses

import type { WhereExpr } from "@dbg/query";

export function extractFilterValue(
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
