// Taps (logpoints) + their hits, read from the event store.

import type { VirtualTable } from "@dbg/query";

export const tapsTable: VirtualTable = {
	name: "taps",
	columns: [
		"id",
		"session_id",
		"breakpoint_id",
		"file",
		"line",
		"expr",
		"url_regex",
		"enabled",
		"created_ts",
	],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) return { columns: this.columns, rows: [] };
		const rows = store
			.query(
				`SELECT id, session_id, breakpoint_id, file, line, expr, url_regex, enabled, created_ts
				 FROM taps ORDER BY id`,
			)
			.map((r) => [
				r.id,
				r.session_id,
				r.breakpoint_id,
				r.file,
				r.line,
				r.expr,
				r.url_regex,
				r.enabled,
				r.created_ts,
			]);
		return { columns: this.columns, rows };
	},
};

export const tapHitsTable: VirtualTable = {
	name: "tap_hits",
	columns: ["id", "tap_id", "ts", "value"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) return { columns: this.columns, rows: [] };
		const rows = store
			.query(
				"SELECT id, tap_id, ts, value FROM tap_hits ORDER BY id DESC LIMIT 1000",
			)
			.reverse()
			.map((r) => [r.id, r.tap_id, r.ts, r.value]);
		return { columns: this.columns, rows };
	},
};
