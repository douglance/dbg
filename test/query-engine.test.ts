import { describe, expect, it } from "vitest";
import { executeQuery, TableRegistry } from "../packages/query/src/index.js";
import { registerCoreTables } from "../packages/tables-core/src/index.js";
import { createExecutor, createState } from "./helpers.js";

describe("query engine", () => {
	const registry = new TableRegistry();
	registerCoreTables(registry);

	it("supports projection/filter/order/limit and json mode suffix", async () => {
		const state = createState({
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "boot",
					url: "file:///a.ts",
					file: "a.ts",
					line: 5,
					col: 0,
					scriptId: "s1",
					scopeChain: [],
					thisObjectId: "",
				},
				{
					callFrameId: "cf-2",
					functionName: "work",
					url: "file:///b.ts",
					file: "b.ts",
					line: 20,
					col: 0,
					scriptId: "s2",
					scopeChain: [],
					thisObjectId: "",
				},
			],
		});
		const { executor } = createExecutor(state);

		const result = await executeQuery(
			"SELECT function, line FROM frames WHERE line > 5 ORDER BY line DESC LIMIT 1\\j",
			executor,
			registry,
		);

		expect(result).toEqual({
			columns: ["function", "line"],
			rows: [["work", 20]],
			format: "json",
		});
	});

	it("throws for unknown table", async () => {
		const { executor } = createExecutor(createState());
		await expect(
			executeQuery("SELECT * FROM nope", executor, registry),
		).rejects.toThrow("Unknown table: 'nope'");
	});

	it("throws when required filters are missing", async () => {
		const { executor } = createExecutor(createState());
		await expect(
			executeQuery("SELECT * FROM props", executor, registry),
		).rejects.toThrow("Table 'props' requires WHERE object_id=...");
	});

	it("throws when selecting a missing column", async () => {
		const { executor } = createExecutor(
			createState({
				callFrames: [
					{
						callFrameId: "cf-1",
						functionName: "boot",
						url: "file:///a.ts",
						file: "a.ts",
						line: 5,
						col: 0,
						scriptId: "s1",
						scopeChain: [],
						thisObjectId: "",
					},
				],
			}),
		);
		await expect(
			executeQuery("SELECT missing FROM frames", executor, registry),
		).rejects.toThrow("Unknown column 'missing' in table 'frames'");
	});

	it("applies ordering only when order column exists", async () => {
		const state = createState({
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "z",
					url: "file:///z.ts",
					file: "z.ts",
					line: 2,
					col: 0,
					scriptId: "s1",
					scopeChain: [],
					thisObjectId: "",
				},
				{
					callFrameId: "cf-2",
					functionName: "a",
					url: "file:///a.ts",
					file: "a.ts",
					line: 1,
					col: 0,
					scriptId: "s2",
					scopeChain: [],
					thisObjectId: "",
				},
			],
		});
		const { executor } = createExecutor(state);

		const result = await executeQuery(
			"SELECT function FROM frames ORDER BY not_a_column DESC",
			executor,
			registry,
		);

		expect(result.columns).toEqual(["function"]);
		expect(result.rows).toEqual([["z"], ["a"]]);
	});

	it("executes timeline filters through the query engine", async () => {
		const { executor } = createExecutor(createState());
		const timelineExecutor = {
			...executor,
			getStore: () => ({
				query: () => [
					{
						id: 2,
						ts: 1002,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.exceptionThrown",
						data: JSON.stringify({
							event: { exceptionDetails: { text: "boom" } },
						}),
						session_id: "s1",
					},
					{
						id: 1,
						ts: 1001,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.consoleAPICalled",
						data: JSON.stringify({
							event: { args: [{ value: "hello" }], type: "log" },
						}),
						session_id: "s1",
					},
				],
			}),
		};

		const result = await executeQuery(
			"SELECT severity, include, detail, window_ms FROM timeline WHERE include = 'errors' AND detail = 'full' AND window_ms = 0 ORDER BY ts DESC",
			timelineExecutor as unknown as Parameters<typeof executeQuery>[1],
			registry,
		);

		expect(result.columns).toEqual([
			"severity",
			"include",
			"detail",
			"window_ms",
		]);
		expect(result.rows).toEqual([["error", "errors", "full", 0]]);
	});
});
