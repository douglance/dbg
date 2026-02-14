// Shared utility for extracting filter values from WHERE clauses

import type { WhereExpr } from "@dbg/query";
import type { DebuggerState } from "@dbg/types";

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

export function assertDapQueryable(state: DebuggerState): void {
	const phase = state.dap?.phase;
	if (phase === "terminated") {
		throw new Error("dap session terminated");
	}
	if (phase === "error") {
		const lastError = state.dap?.lastError;
		if (lastError?.message) {
			throw new Error(lastError.message);
		}
		throw new Error("dap session error");
	}
}
