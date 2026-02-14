import type { VirtualTable } from "@dbg/query";
import { assertDapQueryable } from "./utils.js";

export const signalsTable: VirtualTable = {
	name: "signals",
	columns: ["name", "stop", "pass", "notify"],
	async fetch(_where, executor) {
		assertDapQueryable(executor.getState());
		const response = (await executor.send("signals")) as {
			signals?: Array<{
				name: string;
				stop: boolean;
				pass: boolean;
				notify: boolean;
			}>;
		};

		return {
			columns: this.columns,
			rows: (response.signals ?? []).map((signal) => [
				signal.name,
				signal.stop,
				signal.pass,
				signal.notify,
			]),
		};
	},
};
