import { describe, expect, it } from "vitest";
import { executeQuery } from "../src/query/engine.js";
import { createExecutor, createState } from "./helpers.js";

describe("query engine", () => {
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
		);

		expect(result).toEqual({
			columns: ["function", "line"],
			rows: [["work", 20]],
			format: "json",
		});
	});

	it("throws for unknown table", async () => {
		const { executor } = createExecutor(createState());
		await expect(executeQuery("SELECT * FROM nope", executor)).rejects.toThrow(
			"Unknown table: 'nope'",
		);
	});

	it("throws when required filters are missing", async () => {
		const { executor } = createExecutor(createState());
		await expect(executeQuery("SELECT * FROM props", executor)).rejects.toThrow(
			"Table 'props' requires WHERE object_id=...",
		);
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
			executeQuery("SELECT missing FROM frames", executor),
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
		);

		expect(result.columns).toEqual(["function"]);
		expect(result.rows).toEqual([["z"], ["a"]]);
	});
});
