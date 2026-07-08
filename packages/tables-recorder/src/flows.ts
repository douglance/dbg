// Recorded user flows and replay verdicts, read from the event store.

import type { VirtualTable } from "@dbg/query";

export const flowsTable: VirtualTable = {
	name: "flows",
	columns: ["id", "ts", "name", "url", "session_id"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) return { columns: this.columns, rows: [] };
		const rows = store
			.query("SELECT id, ts, name, url, session_id FROM flows ORDER BY id")
			.map((r) => [r.id, r.ts, r.name, r.url, r.session_id]);
		return { columns: this.columns, rows };
	},
};

export const flowStepsTable: VirtualTable = {
	name: "flow_steps",
	columns: [
		"id",
		"flow_id",
		"idx",
		"kind",
		"selector",
		"fallback_path",
		"value",
		"detail",
	],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) return { columns: this.columns, rows: [] };
		const rows = store
			.query(
				`SELECT id, flow_id, idx, kind, selector, fallback_path, value, detail
				 FROM flow_steps ORDER BY flow_id, idx`,
			)
			.map((r) => [
				r.id,
				r.flow_id,
				r.idx,
				r.kind,
				r.selector,
				r.fallback_path,
				r.value,
				r.detail,
			]);
		return { columns: this.columns, rows };
	},
};

export const flowRunsTable: VirtualTable = {
	name: "flow_runs",
	columns: ["id", "ts", "flow_id", "status", "steps_total", "steps_passed"],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) return { columns: this.columns, rows: [] };
		const rows = store
			.query(
				"SELECT id, ts, flow_id, status, steps_total, steps_passed FROM flow_runs ORDER BY id",
			)
			.map((r) => [
				r.id,
				r.ts,
				r.flow_id,
				r.status,
				r.steps_total,
				r.steps_passed,
			]);
		return { columns: this.columns, rows };
	},
};

export const flowRunStepsTable: VirtualTable = {
	name: "flow_run_steps",
	columns: [
		"id",
		"run_id",
		"step_id",
		"idx",
		"kind",
		"status",
		"capture_id",
		"error",
		"diff_percent",
	],
	async fetch(_where, executor) {
		const store = executor.getStore?.();
		if (!store) return { columns: this.columns, rows: [] };
		const rows = store
			.query(
				`SELECT id, run_id, step_id, idx, kind, status, capture_id, error, diff_percent
				 FROM flow_run_steps ORDER BY run_id, idx`,
			)
			.map((r) => [
				r.id,
				r.run_id,
				r.step_id,
				r.idx,
				r.kind,
				r.status,
				r.capture_id,
				r.error,
				r.diff_percent,
			]);
		return { columns: this.columns, rows };
	},
};
