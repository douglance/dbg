// SQL materialization path.
//
// The legacy engine handles single-table SELECT/WHERE/ORDER/LIMIT/COUNT(*)
// only. For anything richer — JOINs, BETWEEN, GROUP BY, aliases, multi-table
// unions — we materialize each referenced virtual table into an in-memory
// node:sqlite database (fetch() its rows, CREATE + INSERT them) and execute
// the RAW SQL there, so the full SQLite dialect is available.
//
// A query takes this path when it references more than one registered table
// OR when the legacy parser cannot parse it. node:sqlite errors (unknown
// table, syntax errors) propagate verbatim to the caller.

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { DebugExecutor } from "@dbg/types";

import type { WhereExpr } from "./parser.js";
import type { QueryRegistry } from "./registry.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
	DatabaseSync: new (path?: string) => DatabaseSyncType;
};

/** Registered table names appearing in a FROM/JOIN position in the SQL.
 *
 * Only table positions count — a bare identifier scan would misfire on column
 * names that happen to match a registered table (e.g. `SELECT source FROM
 * events`, where `source` is also a table). Comma-joins and subqueries only
 * contribute the identifier immediately after each FROM/JOIN keyword; a table
 * referenced solely via a comma-join is not detected and, if the query also
 * fails the legacy parser, surfaces as a verbatim node:sqlite "no such table"
 * error. Explicit `JOIN` is the supported multi-table form. */
export function referencedTables(sql: string, names: string[]): string[] {
	const registered = new Set(names.map((n) => n.toLowerCase()));
	const found = new Set<string>();
	const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
	let match: RegExpExecArray | null = re.exec(sql);
	while (match !== null) {
		const table = match[1].toLowerCase();
		if (registered.has(table)) found.add(table);
		match = re.exec(sql);
	}
	return names.filter((n) => found.has(n.toLowerCase()));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Best-effort WHERE pushdown: extract simple `col = 'literal'` equalities for
// the table's own columns so scoped tables (commits/agent_prompts/…) fetch the
// right slice. Anything more complex (ranges, ORs, unquoted/numeric literals,
// functions) is NOT pushed down — the table fetches its defaults and the raw
// SQL below applies the real predicate to the materialized rows. Over-fetching
// is safe (the SQL filters); only under-scoping a defaulted table would be
// wrong, which is why explicit `col = 'x'` scoping is honored.
export function pushdownWhere(
	sql: string,
	columns: string[],
): WhereExpr | null {
	const comparisons: WhereExpr[] = [];
	for (const col of columns) {
		const re = new RegExp(`\\b${escapeRegExp(col)}\\s*=\\s*'([^']*)'`, "i");
		const m = re.exec(sql);
		if (m) {
			comparisons.push({
				type: "comparison",
				column: col,
				op: "=",
				value: m[1],
			});
		}
	}
	if (comparisons.length === 0) return null;
	return comparisons.reduce((left, right) => ({ type: "and", left, right }));
}

// Column affinity for the materialized table. Inferred from the fetched
// values: all-numeric → INTEGER (or REAL when a value is non-integer); mixed
// or textual → TEXT, with a name-based fallback keeping ts/id-like columns
// INTEGER even when a column is all-null. INTEGER affinity keeps non-numeric
// strings (e.g. a commit short_hash in timeline.ref_id) as TEXT while storing
// numeric values numerically, so mixed columns still behave.
function columnAffinity(name: string, values: unknown[]): string {
	const nonNull = values.filter((v) => v != null);
	if (nonNull.length > 0 && nonNull.every((v) => typeof v === "number")) {
		return nonNull.every((v) => Number.isInteger(v as number))
			? "INTEGER"
			: "REAL";
	}
	if (name === "session_id") return "TEXT";
	if (
		name === "id" ||
		name === "ts" ||
		name.startsWith("ts_") ||
		name.endsWith("_id") ||
		name === "message_count"
	) {
		return "INTEGER";
	}
	return "TEXT";
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function createAndFill(
	db: DatabaseSyncType,
	table: string,
	columns: string[],
	rows: unknown[][],
): void {
	const colDefs = columns.map((col, i) => {
		const affinity = columnAffinity(
			col,
			rows.map((r) => r[i]),
		);
		return `${quoteIdent(col)} ${affinity}`;
	});
	db.exec(`CREATE TABLE ${quoteIdent(table)} (${colDefs.join(", ")})`);
	if (rows.length === 0) return;
	const placeholders = columns.map(() => "?").join(", ");
	const stmt = db.prepare(
		`INSERT INTO ${quoteIdent(table)} (${columns
			.map(quoteIdent)
			.join(", ")}) VALUES (${placeholders})`,
	);
	db.exec("BEGIN");
	for (const row of rows) {
		// node:sqlite binds JS numbers/strings/null directly; coerce anything
		// exotic (arrays/objects) to a JSON string so the insert never throws.
		const params = row.map((v): number | bigint | string | null =>
			v == null ||
			typeof v === "number" ||
			typeof v === "string" ||
			typeof v === "bigint"
				? (v as number | bigint | string | null)
				: JSON.stringify(v),
		);
		stmt.run(...params);
	}
	db.exec("COMMIT");
}

export async function materializeQuery(
	sql: string,
	referenced: string[],
	executor: DebugExecutor,
	registry: QueryRegistry,
): Promise<{ columns: string[]; rows: unknown[][] }> {
	const db = new DatabaseSync(":memory:");
	try {
		for (const name of referenced) {
			const table =
				registry.getTable(name, executor.protocol) ?? registry.getTable(name);
			if (!table) continue;
			const where = pushdownWhere(sql, table.columns);
			const result = await table.fetch(where, executor);
			createAndFill(db, name, result.columns, result.rows);
		}

		const stmt = db.prepare(sql);
		const objects = stmt.all();
		let columns: string[];
		try {
			columns = stmt.columns().map((c) => c.name);
		} catch {
			columns = objects.length > 0 ? Object.keys(objects[0]) : [];
		}
		const rows = objects.map((obj) => columns.map((c) => obj[c]));
		return { columns, rows };
	} finally {
		db.close();
	}
}
