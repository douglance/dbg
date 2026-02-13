// Scope chains table — reads from daemon state

import type { VirtualTable } from "@dbg/query";

export const scopesTable: VirtualTable = {
	name: "scopes",
	columns: ["id", "frame_id", "type", "name", "object_id"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = [];
		let scopeId = 0;
		for (let fi = 0; fi < state.callFrames.length; fi++) {
			const frame = state.callFrames[fi];
			for (const scope of frame.scopeChain) {
				rows.push([scopeId++, fi, scope.type, scope.name, scope.objectId]);
			}
		}
		return { columns: this.columns, rows };
	},
};
