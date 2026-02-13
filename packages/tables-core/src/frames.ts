// Stack frames table — reads from daemon state

import type { VirtualTable } from "@dbg/query";

export const framesTable: VirtualTable = {
	name: "frames",
	columns: ["id", "function", "file", "line", "col", "url", "script_id"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows = state.callFrames.map((frame, i) => [
			i,
			frame.functionName || "(anonymous)",
			frame.file,
			frame.line,
			frame.col,
			frame.url,
			frame.scriptId,
		]);
		return { columns: this.columns, rows };
	},
};
