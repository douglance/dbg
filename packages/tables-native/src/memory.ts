import type { VirtualTable } from "@dbg/query";
import { extractFilterValue } from "./utils.js";

export const memoryTable: VirtualTable = {
	name: "memory",
	columns: ["address", "offset", "hex", "ascii"],
	requiredFilters: ["address", "length"],
	async fetch(where, executor) {
		const address = String(extractFilterValue(where, "address") ?? "");
		const length = Number(extractFilterValue(where, "length") ?? 0);
		if (!address || !Number.isFinite(length) || length <= 0) {
			return { columns: this.columns, rows: [] };
		}

		const response = (await executor.send("readMemory", {
			memoryReference: address,
			count: length,
		})) as { address?: string; data?: string; unreadableBytes?: number };

		const data = Buffer.from(response.data ?? "", "base64");
		const rows: unknown[][] = [];
		const base = response.address ?? address;

		for (let i = 0; i < data.length; i += 16) {
			const chunk = data.subarray(i, i + 16);
			const hex = Array.from(chunk)
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join(" ");
			const ascii = Array.from(chunk)
				.map((byte) =>
					byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
				)
				.join("");
			rows.push([base, i, hex, ascii]);
		}

		return { columns: this.columns, rows };
	},
};
