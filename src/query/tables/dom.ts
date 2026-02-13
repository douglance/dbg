// DOM query table — queries elements by CSS selector via DOM.querySelectorAll
// Requires WHERE selector=...

import type { VirtualTable } from "./index.js";
import { extractFilterValue } from "./utils.js";

export const domTable: VirtualTable = {
	name: "dom",
	columns: ["node_id", "tag", "id", "class", "text", "attributes"],
	requiredFilters: ["selector"],
	async fetch(where, executor) {
		const selector = extractFilterValue(where, "selector");
		if (!selector) {
			return { columns: this.columns, rows: [] };
		}

		try {
			// Get document root
			const doc = (await executor.send("DOM.getDocument", {
				depth: 0,
			})) as { root: { nodeId: number } };

			// Query all matching nodes
			const result = (await executor.send("DOM.querySelectorAll", {
				nodeId: doc.root.nodeId,
				selector: String(selector),
			})) as { nodeIds: number[] };

			const rows: unknown[][] = [];
			for (const nodeId of result.nodeIds) {
				try {
					const desc = (await executor.send("DOM.describeNode", {
						nodeId,
					})) as {
						node: {
							nodeName: string;
							attributes?: string[];
							nodeValue?: string;
						};
					};

					const attrs = desc.node.attributes ?? [];
					let id = "";
					let className = "";
					const attrPairs: string[] = [];
					for (let i = 0; i < attrs.length; i += 2) {
						const name = attrs[i];
						const value = attrs[i + 1] ?? "";
						if (name === "id") id = value;
						else if (name === "class") className = value;
						attrPairs.push(`${name}=${value}`);
					}

					// Get text content via Runtime
					let text = "";
					try {
						const resolved = (await executor.send("DOM.resolveNode", {
							nodeId,
						})) as { object: { objectId: string } };
						if (resolved.object.objectId) {
							const textResult = (await executor.send(
								"Runtime.callFunctionOn",
								{
									objectId: resolved.object.objectId,
									functionDeclaration:
										"function() { return this.textContent ? this.textContent.trim().substring(0, 200) : ''; }",
									returnByValue: true,
								},
							)) as { result: { value?: string } };
							text = textResult.result.value ?? "";
						}
					} catch {
						// ignore text extraction errors
					}

					rows.push([
						nodeId,
						desc.node.nodeName.toLowerCase(),
						id,
						className,
						text,
						attrPairs.join("; "),
					]);
				} catch {
					// Skip nodes that can't be described
				}
			}

			return { columns: this.columns, rows };
		} catch {
			return { columns: this.columns, rows: [] };
		}
	},
};
