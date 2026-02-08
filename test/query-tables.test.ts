import { describe, expect, it } from "vitest";
import { asyncFramesTable } from "../src/query/tables/async_frames.js";
import { breakpointsTable } from "../src/query/tables/breakpoints.js";
import { consoleTable } from "../src/query/tables/console.js";
import { exceptionsTable } from "../src/query/tables/exceptions.js";
import { framesTable } from "../src/query/tables/frames.js";
import { getTable, listTables } from "../src/query/tables/index.js";
import { listenersTable } from "../src/query/tables/listeners.js";
import { propsTable } from "../src/query/tables/props.js";
import { protoTable } from "../src/query/tables/proto.js";
import { scopesTable } from "../src/query/tables/scopes.js";
import { scriptsTable } from "../src/query/tables/scripts.js";
import { sourceTable } from "../src/query/tables/source.js";
import { thisTable } from "../src/query/tables/this.js";
import { varsTable } from "../src/query/tables/vars.js";
import { createExecutor, createState } from "./helpers.js";

describe("query tables", () => {
	it("maps frame and scope rows from daemon state", async () => {
		const state = createState({
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "",
					url: "file:///a.ts",
					file: "a.ts",
					line: 2,
					col: 1,
					scriptId: "s1",
					scopeChain: [{ type: "local", name: "Local", objectId: "obj-1" }],
					thisObjectId: "",
				},
			],
		});
		const { executor } = createExecutor(state);

		const frameRows = await framesTable.fetch(null, executor);
		const scopeRows = await scopesTable.fetch(null, executor);

		expect(frameRows.rows).toEqual([
			[0, "(anonymous)", "a.ts", 2, 1, "file:///a.ts", "s1"],
		]);
		expect(scopeRows.rows).toEqual([[0, 0, "local", "Local", "obj-1"]]);
	});

	it("expands vars table for non-global scopes and formats value shapes", async () => {
		const state = createState({
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "main",
					url: "file:///main.ts",
					file: "main.ts",
					line: 10,
					col: 0,
					scriptId: "s1",
					scopeChain: [
						{ type: "local", name: "Local", objectId: "scope-local" },
						{ type: "global", name: "Global", objectId: "scope-global" },
					],
					thisObjectId: "",
				},
			],
		});

		const { executor, send } = createExecutor(state, (method, params) => {
			expect(method).toBe("Runtime.getProperties");
			expect(params).toEqual({
				objectId: "scope-local",
				ownProperties: true,
			});
			return {
				result: [
					{ name: "n", value: { type: "number", value: 2 } },
					{
						name: "obj",
						value: { type: "object", className: "Thing", objectId: "child-1" },
					},
					{
						name: "arr",
						value: {
							type: "object",
							subtype: "array",
							description: "Array(2)",
							objectId: "child-2",
						},
					},
					{
						name: "fn",
						value: {
							type: "function",
							description: "function doWork(a, b) { }",
							objectId: "fn-1",
						},
					},
					{ name: "nothing" },
				],
			};
		});

		const result = await varsTable.fetch(null, executor);

		expect(send).toHaveBeenCalledTimes(1);
		expect(result.rows).toEqual([
			[0, "local", "n", "number", "2", ""],
			[0, "local", "obj", "object", "[Thing]", "child-1"],
			[0, "local", "arr", "array", "[Array(2)]", "child-2"],
			[0, "local", "fn", "function", "[Function: doWork]", "fn-1"],
			[0, "local", "nothing", "undefined", "undefined", ""],
		]);
	});

	it("returns empty vars rows for out-of-range frame filter", async () => {
		const state = createState({ callFrames: [] });
		const { executor } = createExecutor(state);
		const result = await varsTable.fetch(
			{
				type: "comparison",
				column: "frame_id",
				op: "=",
				value: 99,
			},
			executor,
		);
		expect(result.rows).toEqual([]);
	});

	it("builds this table preview and handles missing this object", async () => {
		const state = createState({
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "a",
					url: "",
					file: "a.ts",
					line: 1,
					col: 0,
					scriptId: "s1",
					scopeChain: [],
					thisObjectId: "",
				},
				{
					callFrameId: "cf-2",
					functionName: "b",
					url: "",
					file: "b.ts",
					line: 2,
					col: 0,
					scriptId: "s2",
					scopeChain: [],
					thisObjectId: "this-1",
				},
			],
		});
		const { executor } = createExecutor(state, () => ({
			result: [
				{ name: "a" },
				{ name: "b" },
				{ name: "c" },
				{ name: "d" },
				{ name: "e" },
				{ name: "f" },
			],
		}));

		const result = await thisTable.fetch(null, executor);
		expect(result.rows).toEqual([
			[0, "undefined", "undefined", ""],
			[1, "object", "{a, b, c, d, e, ...}", "this-1"],
		]);
	});

	it("maps props table values and returns empty rows without object_id filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, () => ({
			result: [
				{
					name: "obj",
					writable: true,
					configurable: true,
					enumerable: false,
					value: {
						type: "object",
						className: "Box",
						description: "Box",
						objectId: "o-1",
					},
				},
				{
					name: "fn",
					value: { type: "function", objectId: "f-1" },
				},
				{
					name: "num",
					value: { type: "number", value: 3 },
				},
				{
					name: "missing",
				},
			],
		}));

		const empty = await propsTable.fetch(null, executor);
		expect(empty.rows).toEqual([]);

		const rows = await propsTable.fetch(
			{
				type: "comparison",
				column: "object_id",
				op: "=",
				value: "root-1",
			},
			executor,
		);
		expect(rows.rows).toEqual([
			["root-1", "obj", "object", "Box", true, true, false, "o-1"],
			[
				"root-1",
				"fn",
				"function",
				"[Function: fn]",
				false,
				false,
				false,
				"f-1",
			],
			["root-1", "num", "number", "3", false, false, false, ""],
			["root-1", "missing", "undefined", "undefined", false, false, false, ""],
		]);
	});

	it("walks proto table chain until null prototype", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (_method, params) => {
			const id = String((params ?? {}).objectId);
			if (id === "start") {
				return {
					internalProperties: [
						{
							name: "[[Prototype]]",
							value: { className: "A", description: "A", objectId: "p1" },
						},
					],
				};
			}
			if (id === "p1") {
				return {
					internalProperties: [
						{
							name: "[[Prototype]]",
							value: { className: "B", description: "B", objectId: "p2" },
						},
					],
				};
			}
			return {
				internalProperties: [
					{
						name: "[[Prototype]]",
						value: { subtype: "null" },
					},
				],
			};
		});

		const result = await protoTable.fetch(
			{
				type: "comparison",
				column: "object_id",
				op: "=",
				value: "start",
			},
			executor,
		);

		expect(result.rows).toEqual([
			["start", 0, "A", "A", "p1"],
			["p1", 1, "B", "B", "p2"],
		]);
	});

	it("loads source by file LIKE filter or script_id filter", async () => {
		const state = createState({
			scripts: new Map([
				[
					"s1",
					{
						id: "s1",
						file: "main.ts",
						url: "file:///main.ts",
						lines: 2,
						sourceMap: "",
						isModule: false,
					},
				],
			]),
		});
		const { executor, send } = createExecutor(state, (method, params) => {
			expect(method).toBe("Debugger.getScriptSource");
			return { scriptSource: params?.scriptId === "s1" ? "a\nb" : "" };
		});

		await expect(sourceTable.fetch(null, executor)).rejects.toThrow(
			"Table 'source' requires WHERE file=... or script_id=...",
		);

		const byLike = await sourceTable.fetch(
			{
				type: "comparison",
				column: "file",
				op: "LIKE",
				value: "%ain.ts",
			},
			executor,
		);
		expect(byLike.rows).toEqual([
			["s1", "main.ts", 1, "a"],
			["s1", "main.ts", 2, "b"],
		]);

		const byId = await sourceTable.fetch(
			{
				type: "comparison",
				column: "script_id",
				op: "=",
				value: "s1",
			},
			executor,
		);
		expect(byId.rows).toEqual([
			["s1", "main.ts", 1, "a"],
			["s1", "main.ts", 2, "b"],
		]);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("returns empty source rows for unmatched file filters", async () => {
		const state = createState({
			scripts: new Map([
				[
					"s1",
					{
						id: "s1",
						file: "main.ts",
						url: "file:///main.ts",
						lines: 1,
						sourceMap: "",
						isModule: false,
					},
				],
			]),
		});
		const { executor } = createExecutor(state);
		const result = await sourceTable.fetch(
			{
				type: "comparison",
				column: "file",
				op: "=",
				value: "not-found.ts",
			},
			executor,
		);
		expect(result.rows).toEqual([]);
	});

	it("maps listeners table and enforces object_id filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, () => ({
			listeners: [
				{
					type: "click",
					handler: { description: "onClick" },
					once: true,
					useCapture: false,
				},
			],
		}));

		const empty = await listenersTable.fetch(null, executor);
		expect(empty.rows).toEqual([]);

		const rows = await listenersTable.fetch(
			{
				type: "comparison",
				column: "object_id",
				op: "=",
				value: "obj-7",
			},
			executor,
		);
		expect(rows.rows).toEqual([["obj-7", "click", "onClick", true, false]]);
	});

	it("maps simple state-backed tables", async () => {
		const state = createState({
			breakpoints: new Map([
				[
					"bp-1",
					{
						id: "bp-1",
						file: "app.ts",
						line: 3,
						condition: "",
						hits: 2,
						enabled: true,
						cdpBreakpointId: "bp-1",
					},
				],
			]),
			scripts: new Map([
				[
					"s1",
					{
						id: "s1",
						file: "app.ts",
						url: "file:///app.ts",
						lines: 9,
						sourceMap: "app.ts.map",
						isModule: true,
					},
				],
			]),
			console: [{ id: 1, type: "log", text: "hello", ts: 1, stack: "s" }],
			exceptions: [
				{
					id: 1,
					text: "boom",
					type: "Error",
					file: "app.ts",
					line: 9,
					ts: 2,
					uncaught: true,
				},
			],
			asyncStackTrace: [
				{
					id: 1,
					functionName: "work",
					file: "work.ts",
					line: 7,
					parentId: null,
					description: "await",
				},
			],
		});
		const { executor } = createExecutor(state);

		expect((await breakpointsTable.fetch(null, executor)).rows).toEqual([
			["bp-1", "app.ts", 3, "", 2, true],
		]);
		expect((await scriptsTable.fetch(null, executor)).rows).toEqual([
			["s1", "app.ts", "file:///app.ts", 9, "app.ts.map", true],
		]);
		expect((await consoleTable.fetch(null, executor)).rows).toEqual([
			[1, "log", "hello", 1, "s"],
		]);
		expect((await exceptionsTable.fetch(null, executor)).rows).toEqual([
			[1, "boom", "Error", "app.ts", 9, 2, true],
		]);
		expect((await asyncFramesTable.fetch(null, executor)).rows).toEqual([
			[1, "work", "work.ts", 7, null, "await"],
		]);
	});

	it("registers all expected tables in the registry", () => {
		const tables = listTables();
		expect(tables).toContain("frames");
		expect(tables).toContain("vars");
		expect(tables).toContain("listeners");
		expect(getTable("frames")?.name).toBe("frames");
		expect(getTable("nope")).toBeUndefined();
	});
});
