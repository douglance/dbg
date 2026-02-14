import type { VirtualTable } from "@dbg/query";
import { assertDapQueryable } from "./utils.js";

export const watchpointsTable: VirtualTable = {
	name: "watchpoints",
	columns: ["id", "expression", "access", "enabled"],
	async fetch(_where, executor) {
		assertDapQueryable(executor.getState());
		const response = (await executor.send("watchpoints")) as {
			watchpoints?: Array<{
				id: string | number;
				expression: string;
				access: string;
				enabled: boolean;
			}>;
		};

		return {
			columns: this.columns,
			rows: (response.watchpoints ?? []).map((watchpoint) => [
				String(watchpoint.id),
				watchpoint.expression,
				watchpoint.access,
				watchpoint.enabled,
			]),
		};
	},
};
