import { describe, expect, it } from "vitest";
import {
	CDP_CAPABILITIES,
	type CdpExecutor,
	type DaemonState,
} from "../packages/types/src/index.js";
import type { WhereExpr } from "../packages/query/src/parser.js";
import { sourceTable } from "../packages/tables-core/src/source.js";

function createState(): DaemonState {
	return {
		connected: true,
		paused: true,
		pid: null,
		managedCommand: null,
		callFrames: [],
		asyncStackTrace: [],
		breakpoints: new Map(),
		scripts: new Map(),
		console: [],
		exceptions: [],
		cdp: {
			lastWsUrl: null,
			networkRequests: new Map(),
			pageEvents: [],
			wsFrames: [],
			coverageSnapshot: null,
		},
	};
}

describe("source table", () => {
	it("treats regex metacharacters as literals in LIKE patterns", async () => {
		const state = createState();
		state.scripts.set("1", {
			id: "1",
			file: "appXts",
			url: "file:///appXts",
			lines: 1,
			sourceMap: "",
			isModule: false,
		});
		state.scripts.set("2", {
			id: "2",
			file: "app.ts",
			url: "file:///app.ts",
			lines: 1,
			sourceMap: "",
			isModule: false,
		});

		let requestedScriptId = "";
		const executor: CdpExecutor = {
			getState: () => state,
			protocol: "cdp",
			capabilities: CDP_CAPABILITIES,
			send: async (method, params) => {
				expect(method).toBe("Debugger.getScriptSource");
				requestedScriptId = (params as { scriptId: string }).scriptId;
				return {
					scriptSource:
						requestedScriptId === "2"
							? "const ok = true;"
							: "const wrong = true;",
				};
			},
		};

		const where: WhereExpr = {
			type: "comparison",
			column: "file",
			op: "LIKE",
			value: "app.ts",
		};

		const result = await sourceTable.fetch(where, executor);
		expect(requestedScriptId).toBe("2");
		expect(result.rows).toEqual([["2", "app.ts", 1, "const ok = true;"]]);
	});
});
