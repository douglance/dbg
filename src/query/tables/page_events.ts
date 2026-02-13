// Page events table — reads accumulated state from pageEvents array

import type { VirtualTable } from "./index.js";

export const pageEventsTable: VirtualTable = {
	name: "page_events",
	columns: ["id", "name", "ts", "frame_id", "url"],
	async fetch(_where, executor) {
		const state = executor.getState();
		const rows: unknown[][] = state.pageEvents.map((event) => [
			event.id,
			event.name,
			event.ts,
			event.frameId,
			event.url,
		]);
		return { columns: this.columns, rows };
	},
};
