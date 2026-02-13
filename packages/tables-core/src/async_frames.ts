// Async stack traces table — reads from daemon state

import type { VirtualTable } from "@dbg/query";

export const asyncFramesTable: VirtualTable = {
	name: "async_frames",
	columns: ["id", "function", "file", "line", "parent_id", "description"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = state.asyncStackTrace.map((entry) => [
			entry.id,
			entry.functionName,
			entry.file,
			entry.line,
			entry.parentId,
			entry.description,
		]);
		return { columns: this.columns, rows };
	},
};
