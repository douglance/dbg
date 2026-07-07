// `timeline` — a unified, epoch-ms-ordered stream over every development
// signal, as a read-only virtual table.
//
// Columns: (ts, kind, session_id, label, ref_id, detail).
//   kind ∈ capture | mark | epoch | edit | error | exception | commit |
//          prompt | diff
//   label   — human-facing summary (url, path, error text, commit summary…)
//   ref_id  — the source row's natural id (capture id, commit short_hash…)
//   detail  — small JSON blob of source-specific extras, or null
//
// The union sources from three places, all already epoch-ms aligned:
//   • the event store (captures, epochs, edits, diffs) via executor.getStore()
//   • the live session state (console errors, exceptions) via getState()
//   • the dev tables (commits, agent_prompts) via their own fetch()
//
// Network failures are intentionally NOT included yet: CDP Network timestamps
// are monotonic-clock seconds, not epoch-ms wall time, so they would violate
// the unified ts contract. (Deferred to the Plan V network work, which records
// wall time.)
//
// Default window: the last 24h, UNLESS the WHERE clause constrains `ts` (any
// comparison on ts opts into the full history the sources retain). The engine
// / materializer re-applies the real WHERE afterwards, so returning a superset
// is always safe.

import type { VirtualTable, WhereExpr } from "@dbg/query";

import { agentPromptsTable } from "./agent-prompts.js";
import { commitsTable } from "./commits.js";
import { whereReferencesColumn } from "./internal.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_MAX = 120;
// Bound per-source store scans so the union stays sub-second on long recordings.
const SOURCE_LIMIT = 2000;

interface TimelineState {
	console?: Array<{ type?: string; text?: string; ts?: number; id?: number }>;
	exceptions?: Array<{
		text?: string;
		ts?: number;
		id?: number;
		file?: string;
		line?: number;
	}>;
}

export const timelineTable: VirtualTable = {
	name: "timeline",
	columns: ["ts", "kind", "session_id", "label", "ref_id", "detail"],
	async fetch(where: WhereExpr | null, executor) {
		const now = Date.now();
		const since = whereReferencesColumn(where, "ts")
			? Number.NEGATIVE_INFINITY
			: now - DAY_MS;
		const rows: unknown[][] = [];

		const push = (
			ts: unknown,
			kind: string,
			sessionId: unknown,
			label: unknown,
			refId: unknown,
			detail: unknown,
		): void => {
			const tsNum = Number(ts);
			if (!Number.isFinite(tsNum) || tsNum < since) return;
			rows.push([
				tsNum,
				kind,
				sessionId ?? null,
				String(label ?? "").slice(0, LABEL_MAX),
				refId ?? null,
				detail == null ? null : JSON.stringify(detail),
			]);
		};

		// ── Store-backed sources: captures / epochs / edits / diffs ──
		const store = executor.getStore?.();
		if (store) {
			for (const r of store.query(
				`SELECT id, ts, session_id, url, epoch_id FROM captures ORDER BY id DESC LIMIT ${SOURCE_LIMIT}`,
			)) {
				push(r.ts, "capture", r.session_id, r.url, r.id, {
					epoch_id: r.epoch_id ?? null,
				});
			}
			for (const r of store.query(
				`SELECT id, ts, session_id, name FROM epochs ORDER BY id DESC LIMIT ${SOURCE_LIMIT}`,
			)) {
				const named = r.name != null && String(r.name) !== "";
				push(
					r.ts,
					named ? "mark" : "epoch",
					r.session_id,
					r.name ?? "",
					r.id,
					null,
				);
			}
			for (const r of store.query(
				`SELECT id, ts, session_id, path, epoch_id FROM edits ORDER BY id DESC LIMIT ${SOURCE_LIMIT}`,
			)) {
				push(r.ts, "edit", r.session_id, r.path, r.id, {
					epoch_id: r.epoch_id ?? null,
				});
			}
			for (const r of store.query(
				`SELECT id, ts, name FROM diffs ORDER BY id DESC LIMIT ${SOURCE_LIMIT}`,
			)) {
				push(r.ts, "diff", null, r.name ?? "", r.id, null);
			}
		}

		// ── Live session state: console errors + exceptions ──
		const state = executor.getState?.() as TimelineState | undefined;
		if (state) {
			for (const e of state.console ?? []) {
				if (e.type !== "error" && e.type !== "assert") continue;
				push(e.ts, "error", null, e.text ?? "", e.id ?? null, null);
			}
			for (const ex of state.exceptions ?? []) {
				push(ex.ts, "exception", null, ex.text ?? "", ex.id ?? null, {
					file: ex.file ?? null,
					line: ex.line ?? null,
				});
			}
		}

		// ── Dev tables: commits + agent prompts (git / ~/.claude) ──
		const [commits, prompts] = await Promise.all([
			commitsTable.fetch(where, executor),
			agentPromptsTable.fetch(where, executor),
		]);
		const cCol = (name: string) => commits.columns.indexOf(name);
		for (const row of commits.rows) {
			push(
				row[cCol("ts")],
				"commit",
				null,
				row[cCol("summary")],
				row[cCol("short_hash")],
				{ hash: row[cCol("hash")] },
			);
		}
		const pCol = (name: string) => prompts.columns.indexOf(name);
		for (const row of prompts.rows) {
			push(row[pCol("ts")], "prompt", null, row[pCol("display")], null, {
				project: row[pCol("project")],
			});
		}

		rows.sort((a, b) => Number(a[0]) - Number(b[0]));
		return { columns: this.columns, rows };
	},
};
