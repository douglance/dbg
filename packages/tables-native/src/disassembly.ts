import type { VirtualTable } from "@dbg/query";
import { assertDapQueryable, extractFilterValue } from "./utils.js";

export const disassemblyTable: VirtualTable = {
	name: "disassembly",
	columns: ["address", "instruction", "symbol", "location"],
	requiredFilters: ["address"],
	async fetch(where, executor) {
		assertDapQueryable(executor.getState());
		const address = String(extractFilterValue(where, "address") ?? "");
		const count = Number(extractFilterValue(where, "count") ?? 32);
		if (!address) {
			return { columns: this.columns, rows: [] };
		}

		const response = (await executor.send("disassemble", {
			memoryReference: address,
			offset: 0,
			instructionCount: Number.isFinite(count) && count > 0 ? count : 32,
		})) as {
			instructions?: Array<{
				address?: string;
				instruction?: string;
				symbol?: string;
				location?: { path?: string; line?: number };
			}>;
		};

		const rows = (response.instructions ?? []).map((instruction) => [
			instruction.address ?? "",
			instruction.instruction ?? "",
			instruction.symbol ?? "",
			instruction.location?.path
				? `${instruction.location.path}:${instruction.location.line ?? 0}`
				: "",
		]);
		return { columns: this.columns, rows };
	},
};
