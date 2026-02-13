// Prototype chain table — walks __proto__ via Runtime.getProperties
// Requires WHERE object_id=...

import type { VirtualTable } from "@dbg/query";
import { extractFilterValue } from "./utils.js";

export const protoTable: VirtualTable = {
	name: "proto",
	columns: ["object_id", "depth", "type", "value", "proto_id"],
	requiredFilters: ["object_id"],
	async fetch(where, executor) {
		const objectId = extractFilterValue(where, "object_id");
		if (!objectId) {
			return { columns: this.columns, rows: [] };
		}

		const rows: unknown[][] = [];
		let currentId = String(objectId);
		let depth = 0;
		const maxDepth = 20; // safety limit

		while (depth < maxDepth) {
			const result = (await executor.send("Runtime.getProperties", {
				objectId: currentId,
				ownProperties: true,
			})) as {
				internalProperties?: Array<{
					name: string;
					value?: {
						type?: string;
						subtype?: string;
						className?: string;
						description?: string;
						objectId?: string;
					};
				}>;
			};

			const proto = result.internalProperties?.find(
				(p) => p.name === "[[Prototype]]",
			);
			if (!proto?.value || proto.value.subtype === "null") break;

			const val = proto.value;
			const protoId = val.objectId ?? "";
			rows.push([
				currentId,
				depth,
				val.className ?? val.type ?? "object",
				val.description ?? `[${val.className ?? "Object"}]`,
				protoId,
			]);

			if (!protoId) break;
			currentId = protoId;
			depth++;
		}

		return { columns: this.columns, rows };
	},
};
