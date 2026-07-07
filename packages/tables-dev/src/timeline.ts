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
// Network failures ('netfail') are reconstructed from the raw events table,
// whose `ts` is wall-clock epoch-ms at receipt (NOT CDP's monotonic
// Network.*.timestamp) — so they honor the unified ts contract.
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

interface StoreLike {
	query(sql: string, params?: unknown[]): Record<string, unknown>[];
}

interface NetFailure {
	ts: number;
	label: string;
	requestId: string;
	status?: number;
	error?: string;
}

/** Network failures from the raw events table (wall-clock `ts`). */
function networkFailuresFromEvents(store: StoreLike): NetFailure[] {
	const rows = store.query(
		`SELECT ts, method, data FROM events
		 WHERE source = 'cdp_recv'
		   AND method IN ('Network.requestWillBeSent','Network.responseReceived','Network.loadingFailed')
		 ORDER BY id`,
	);
	const urls = new Map<string, { url: string; method: string }>();
	const failures: NetFailure[] = [];
	for (const row of rows) {
		let data: {
			event?: {
				requestId?: string;
				request?: { url?: string; method?: string };
				response?: { url?: string; status?: number };
				errorText?: string;
			};
		};
		try {
			data = JSON.parse(String(row.data ?? "{}"));
		} catch {
			continue;
		}
		const event = data.event;
		const requestId = event?.requestId;
		if (!requestId) continue;
		const ts = Number(row.ts);
		if (row.method === "Network.requestWillBeSent") {
			if (event?.request?.url) {
				urls.set(requestId, {
					url: event.request.url,
					method: event.request.method ?? "GET",
				});
			}
		} else if (row.method === "Network.loadingFailed") {
			const req = urls.get(requestId);
			failures.push({
				ts,
				requestId,
				label:
					`${req?.method ?? ""} ${req?.url ?? "(unknown)"} ${event?.errorText ?? "failed"}`.trim(),
				error: event?.errorText ?? "failed",
			});
		} else if (
			row.method === "Network.responseReceived" &&
			(event?.response?.status ?? 0) >= 400
		) {
			const req = urls.get(requestId);
			const status = event?.response?.status;
			failures.push({
				ts,
				requestId,
				label:
					`${req?.method ?? ""} ${event?.response?.url ?? req?.url ?? "(unknown)"} ${status ?? ""}`.trim(),
				status,
			});
		}
	}
	return failures;
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

			// Network failures reconstructed from the raw events (whose `ts` is
			// wall-clock epoch-ms at receipt — unlike CDP's monotonic
			// Network.*.timestamp): loadingFailed (any) + responseReceived >= 400.
			for (const nf of networkFailuresFromEvents(store)) {
				push(nf.ts, "netfail", null, nf.label, nf.requestId, {
					status: nf.status ?? null,
					error: nf.error ?? null,
				});
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
