// WebSocket frames table — reads from daemon state

import type { VirtualTable } from "./index.js";

export const wsFramesTable: VirtualTable = {
	name: "ws_frames",
	columns: ["id", "request_id", "opcode", "data", "ts", "direction"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = state.wsFrames.map((frame) => [
			frame.id,
			frame.requestId,
			frame.opcode,
			frame.data,
			frame.ts,
			frame.direction,
		]);
		return { columns: this.columns, rows };
	},
};
