// Shared helpers for the dev tables (git + Claude Code agent history).
//
// Data-source root for agent history is ~/.claude, overridable via
// $DBG_CLAUDE_DIR (read at fetch time so tests can point at fixtures).

import { homedir } from "node:os";
import { join } from "node:path";

import type { WhereExpr } from "@dbg/query";

export function claudeDir(): string {
	return process.env.DBG_CLAUDE_DIR || join(homedir(), ".claude");
}

// Claude Code project-slug convention: the absolute project path with
// every '/' and '.' replaced by '-'.
// e.g. /Users/doug/Developer/lv/dbg -> -Users-doug-Developer-lv-dbg
export function projectSlug(dir: string): string {
	return dir.replace(/[/.]/g, "-");
}

// True if any comparison in the WHERE tree references `column`. Used to
// decide whether the caller opted into explicit project scoping (the
// engine re-applies the full WHERE after fetch, so the table only has to
// return a superset of the matching rows).
export function whereReferencesColumn(
	where: WhereExpr | null,
	column: string,
): boolean {
	if (!where) return false;
	switch (where.type) {
		case "comparison":
			return where.column === column;
		case "and":
		case "or":
			return (
				whereReferencesColumn(where.left, column) ||
				whereReferencesColumn(where.right, column)
			);
		case "paren":
			return whereReferencesColumn(where.expr, column);
	}
}

// Normalize a timestamp that may be an epoch-ms number, a numeric string
// of epoch-ms, or an ISO-8601 string. Returns epoch-ms or null.
export function toEpochMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string" && value !== "") {
		const asNumber = Number(value);
		if (Number.isFinite(asNumber)) return Math.trunc(asNumber);
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return null;
}
