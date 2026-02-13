import { describe, expect, it } from "vitest";
import { TableRegistry } from "../packages/query/src/index.js";
import {
	asyncFramesTable,
	breakpointsTable,
	cdpMessagesTable,
	cdpTable,
	connectionsTable,
	consoleTable,
	eventsTable,
	exceptionsTable,
	framesTable,
	listenersTable,
	propsTable,
	protoTable,
	registerCoreTables,
	scopesTable,
	scriptsTable,
	thisTable,
	timelineTable,
	varsTable,
} from "../packages/tables-core/src/index.js";
import {
	cookiesTable,
	coverageTable,
	domTable,
	networkBodyTable,
	networkHeadersTable,
	networkTable,
	pageEventsTable,
	performanceTable,
	registerBrowserTables,
	storageTable,
	stylesTable,
	wsFramesTable,
} from "../packages/tables-browser/src/index.js";
import { sourceTable } from "../packages/tables-core/src/source.js";
import { createExecutor, createState } from "./helpers.js";

describe("query tables", () => {
	it("uses stored coverage snapshot when live coverage is unavailable", async () => {
		const state = createState({
			cdp: {
				coverageSnapshot: {
					js: [
						{
							url: "file:///app.js",
							functions: [
								{
									ranges: [
										{ startOffset: 0, endOffset: 120, count: 1 },
										{ startOffset: 120, endOffset: 200, count: 0 },
									],
								},
							],
						},
					],
					css: [
						{
							styleSheetId: "sheet-1",
							startOffset: 0,
							endOffset: 50,
							used: true,
						},
						{
							styleSheetId: "sheet-1",
							startOffset: 50,
							endOffset: 100,
							used: false,
						},
					],
					capturedAt: Date.now(),
				},
			},
		});
		const { executor, send } = createExecutor(state, () => {
			throw new Error("coverage not active");
		});

		const result = await coverageTable.fetch(null, executor);
		expect(send).toHaveBeenCalledTimes(2);
		expect(result.rows).toEqual([
			["file:///app.js", 200, 120, 60],
			["css:sheet-1", 100, 50, 50],
		]);
	});

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
			const id = String(params?.objectId);
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

	it("maps network requests from daemon state", async () => {
		const state = createState({
			cdp: {
				networkRequests: new Map([
					[
						"req-1",
						{
							id: "req-1",
							url: "https://example.com/api",
							method: "GET",
							status: 200,
							type: "XHR",
							mimeType: "application/json",
							startTime: 1000,
							endTime: 1050,
							duration: 50,
							size: 1024,
							error: "",
							requestHeaders: "{}",
							responseHeaders: "{}",
							initiator: "script",
						},
					],
				]),
			},
		});
		const { executor } = createExecutor(state);
		const result = await networkTable.fetch(null, executor);
		expect(result.rows).toEqual([
			[
				"req-1",
				"GET",
				"https://example.com/api",
				200,
				"XHR",
				"application/json",
				50,
				1024,
				"",
				"script",
			],
		]);
	});

	it("returns empty rows for empty network requests", async () => {
		const state = createState({ cdp: { networkRequests: new Map() } });
		const { executor } = createExecutor(state);
		const result = await networkTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("maps page events from daemon state", async () => {
		const state = createState({
			cdp: {
				pageEvents: [
					{
						id: 1,
						name: "load",
						ts: 1234,
						frameId: "frame-1",
						url: "https://example.com",
					},
				],
			},
		});
		const { executor } = createExecutor(state);
		const result = await pageEventsTable.fetch(null, executor);
		expect(result.rows).toEqual([
			[1, "load", 1234, "frame-1", "https://example.com"],
		]);
	});

	it("returns empty rows for empty page events", async () => {
		const state = createState({ cdp: { pageEvents: [] } });
		const { executor } = createExecutor(state);
		const result = await pageEventsTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("maps websocket frames from daemon state", async () => {
		const state = createState({
			cdp: {
				wsFrames: [
					{
						id: 1,
						requestId: "ws-1",
						opcode: 1,
						data: "hello",
						ts: 100,
						direction: "sent" as const,
					},
					{
						id: 2,
						requestId: "ws-1",
						opcode: 1,
						data: "world",
						ts: 200,
						direction: "received" as const,
					},
				],
			},
		});
		const { executor } = createExecutor(state);
		const result = await wsFramesTable.fetch(null, executor);
		expect(result.rows).toEqual([
			[1, "ws-1", 1, "hello", 100, "sent"],
			[2, "ws-1", 1, "world", 200, "received"],
		]);
	});

	it("fetches cookies via CDP and maps rows", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method) => {
			if (method === "Network.getCookies") {
				return {
					cookies: [
						{
							name: "sid",
							value: "abc",
							domain: ".example.com",
							path: "/",
							expires: 0,
							size: 6,
							httpOnly: true,
							secure: true,
							sameSite: "Lax",
						},
					],
				};
			}
			return {};
		});
		const result = await cookiesTable.fetch(null, executor);
		expect(result.rows).toEqual([
			["sid", "abc", ".example.com", "/", 0, 6, true, true, "Lax"],
		]);
	});

	it("returns empty cookies rows when send throws", async () => {
		const state = createState();
		const { executor } = createExecutor(state, () => {
			throw new Error("no target");
		});
		const result = await cookiesTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("fetches performance metrics via CDP", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method) => {
			if (method === "Performance.getMetrics") {
				return {
					metrics: [{ name: "JSHeapUsedSize", value: 1024000 }],
				};
			}
			return {};
		});
		const result = await performanceTable.fetch(null, executor);
		expect(result.rows).toEqual([["JSHeapUsedSize", 1024000]]);
	});

	it("returns empty performance rows when send throws", async () => {
		const state = createState();
		const { executor } = createExecutor(state, () => {
			throw new Error("no target");
		});
		const result = await performanceTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("fetches computed styles with node_id filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method, params) => {
			if (method === "CSS.getComputedStyleForNode") {
				expect(params).toEqual({ nodeId: 42 });
				return {
					computedStyle: [{ name: "color", value: "rgb(0, 0, 0)" }],
				};
			}
			return {};
		});
		const result = await stylesTable.fetch(
			{ type: "comparison", column: "node_id", op: "=", value: 42 },
			executor,
		);
		expect(result.rows).toEqual([[42, "color", "rgb(0, 0, 0)"]]);
	});

	it("returns empty styles rows without node_id filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const result = await stylesTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("fetches network response body with request_id filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method) => {
			if (method === "Network.getResponseBody") {
				return { body: '{"ok":true}', base64Encoded: false };
			}
			return {};
		});
		const result = await networkBodyTable.fetch(
			{
				type: "comparison",
				column: "request_id",
				op: "=",
				value: "req-1",
			},
			executor,
		);
		expect(result.rows).toEqual([["req-1", '{"ok":true}', false]]);
	});

	it("returns empty network body rows without request_id filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const result = await networkBodyTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("parses network headers from state with request_id filter", async () => {
		const state = createState({
			cdp: {
				networkRequests: new Map([
					[
						"req-1",
						{
							id: "req-1",
							url: "https://example.com",
							method: "GET",
							status: 200,
							type: "XHR",
							mimeType: "text/html",
							startTime: 0,
							endTime: 0,
							duration: 0,
							size: 0,
							error: "",
							requestHeaders: JSON.stringify({ Accept: "text/html" }),
							responseHeaders: JSON.stringify({
								"Content-Type": "text/html",
							}),
							initiator: "other",
						},
					],
				]),
			},
		});
		const { executor } = createExecutor(state);
		const result = await networkHeadersTable.fetch(
			{
				type: "comparison",
				column: "request_id",
				op: "=",
				value: "req-1",
			},
			executor,
		);
		expect(result.rows).toEqual([
			["req-1", "request", "Accept", "text/html"],
			["req-1", "response", "Content-Type", "text/html"],
		]);
	});

	it("returns empty network headers without filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const result = await networkHeadersTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("returns empty network headers for missing request_id", async () => {
		const state = createState({ cdp: { networkRequests: new Map() } });
		const { executor } = createExecutor(state);
		const result = await networkHeadersTable.fetch(
			{
				type: "comparison",
				column: "request_id",
				op: "=",
				value: "missing",
			},
			executor,
		);
		expect(result.rows).toEqual([]);
	});

	it("fetches localStorage entries with type filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method, params) => {
			if (method === "Runtime.evaluate") {
				const expr = String(params?.expression);
				expect(expr).toContain("localStorage");
				return {
					result: {
						value: JSON.stringify([{ k: "theme", v: "dark" }]),
					},
				};
			}
			return {};
		});
		const result = await storageTable.fetch(
			{ type: "comparison", column: "type", op: "=", value: "local" },
			executor,
		);
		expect(result.rows).toEqual([["local", "theme", "dark"]]);
	});

	it("fetches sessionStorage entries with session type filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method, params) => {
			if (method === "Runtime.evaluate") {
				const expr = String(params?.expression);
				expect(expr).toContain("sessionStorage");
				return {
					result: {
						value: JSON.stringify([{ k: "token", v: "xyz" }]),
					},
				};
			}
			return {};
		});
		const result = await storageTable.fetch(
			{ type: "comparison", column: "type", op: "=", value: "session" },
			executor,
		);
		expect(result.rows).toEqual([["session", "token", "xyz"]]);
	});

	it("returns empty storage rows without filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const result = await storageTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("returns empty storage rows for invalid type", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const result = await storageTable.fetch(
			{
				type: "comparison",
				column: "type",
				op: "=",
				value: "invalid",
			},
			executor,
		);
		expect(result.rows).toEqual([]);
	});

	it("queries DOM elements with selector filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method, params) => {
			switch (method) {
				case "DOM.getDocument":
					return { root: { nodeId: 1 } };
				case "DOM.querySelectorAll":
					return { nodeIds: [10] };
				case "DOM.describeNode":
					return {
						node: {
							nodeName: "DIV",
							attributes: ["id", "main", "class", "container"],
						},
					};
				case "DOM.resolveNode":
					return { object: { objectId: "obj-10" } };
				case "Runtime.callFunctionOn":
					return { result: { value: "Hello World" } };
				default:
					return {};
			}
		});
		const result = await domTable.fetch(
			{
				type: "comparison",
				column: "selector",
				op: "=",
				value: "div#main",
			},
			executor,
		);
		expect(result.rows).toEqual([
			[
				10,
				"div",
				"main",
				"container",
				"Hello World",
				"id=main; class=container",
			],
		]);
	});

	it("returns empty DOM rows without selector filter", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const result = await domTable.fetch(null, executor);
		expect(result.rows).toEqual([]);
	});

	it("fetches live coverage from CDP calls", async () => {
		const state = createState();
		const { executor } = createExecutor(state, (method) => {
			switch (method) {
				case "Profiler.takePreciseCoverage":
					return {
						result: [
							{
								url: "app.js",
								functions: [
									{
										ranges: [
											{
												startOffset: 0,
												endOffset: 100,
												count: 1,
											},
											{
												startOffset: 100,
												endOffset: 200,
												count: 0,
											},
										],
									},
								],
							},
						],
					};
				case "CSS.takeCoverageDelta":
					return { coverage: [] };
				default:
					return {};
			}
		});
		const result = await coverageTable.fetch(null, executor);
		expect(result.rows).toEqual([["app.js", 200, 100, 50]]);
	});

	it("builds compact timeline rows and coalesces repeated events", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const timelineExecutor = {
			...executor,
			getStore: () => ({
				query: () => [
					{
						id: 4,
						ts: 1004,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.exceptionThrown",
						data: JSON.stringify({
							event: { exceptionDetails: { text: "boom" } },
						}),
						session_id: "s1",
					},
					{
						id: 3,
						ts: 1003,
						source: "cdp_recv",
						category: "cdp",
						method: "Network.responseReceived",
						data: JSON.stringify({
							event: {
								requestId: "req-1",
								type: "XHR",
								response: {
									status: 500,
									url: "https://example.com/api",
								},
							},
						}),
						session_id: "s1",
					},
					{
						id: 2,
						ts: 1002,
						source: "cdp_send",
						category: "cdp",
						method: "Runtime.evaluate",
						data: JSON.stringify({ params: { expression: "1+1" } }),
						session_id: "s1",
					},
					{
						id: 1,
						ts: 1001,
						source: "cdp_send",
						category: "cdp",
						method: "Runtime.evaluate",
						data: JSON.stringify({ params: { expression: "1+1" } }),
						session_id: "s1",
					},
				],
			}),
		};

		const result = await timelineTable.fetch(
			null,
			timelineExecutor as unknown as Parameters<typeof timelineTable.fetch>[1],
		);

		expect(result.rows).toHaveLength(3);
		expect(result.rows[0][6]).toContain("(x2)");
		expect(result.rows[0][10]).toBe("events:1-2");
		expect(result.rows[2][7]).toBe("error");
		expect(result.rows[2][12]).toBe("all");
		expect(result.rows[2][11]).toBe("compact");
		expect(result.rows[2][13]).toBe(0);
	});

	it("suppresses startup debugger noise in compact mode", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const timelineExecutor = {
			...executor,
			getStore: () => ({
				query: () => [
					{
						id: 5,
						ts: 3005,
						source: "cdp_recv",
						category: "cdp",
						method: "Debugger.scriptParsed.undefined",
						data: JSON.stringify({
							event: { scriptId: "s1", url: "file:///x.ts" },
						}),
						session_id: "s1",
					},
					{
						id: 4,
						ts: 3004,
						source: "cdp_recv",
						category: "cdp",
						method: "Debugger.scriptParsed",
						data: JSON.stringify({
							event: { scriptId: "s2", url: "file:///y.ts" },
						}),
						session_id: "s1",
					},
					{
						id: 3,
						ts: 3003,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.executionContextCreated.undefined",
						data: JSON.stringify({
							event: { context: { id: 1 } },
						}),
						session_id: "s1",
					},
					{
						id: 2,
						ts: 3002,
						source: "cdp_send",
						category: "cdp",
						method: "Runtime.evaluate",
						data: JSON.stringify({ params: { expression: "2+2" } }),
						session_id: "s1",
					},
					{
						id: 1,
						ts: 3001,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.exceptionThrown.undefined",
						data: JSON.stringify({
							event: { exceptionDetails: { text: "boom" } },
						}),
						session_id: "s1",
					},
				],
			}),
		};

		const result = await timelineTable.fetch(
			null,
			timelineExecutor as unknown as Parameters<typeof timelineTable.fetch>[1],
		);

		expect(result.rows).toHaveLength(2);
		expect(result.rows[0][5]).toBe("Runtime.exceptionThrown");
		expect(result.rows[1][5]).toBe("Runtime.evaluate");
		expect(result.rows[0][7]).toBe("error");
		const methods = result.rows.map((row) => String(row[5]));
		expect(methods.some((method) => method.endsWith(".undefined"))).toBe(false);
	});

	it("filters timeline by include=errors", async () => {
		const state = createState();
		const { executor } = createExecutor(state);
		const timelineExecutor = {
			...executor,
			getStore: () => ({
				query: () => [
					{
						id: 2,
						ts: 2002,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.exceptionThrown",
						data: JSON.stringify({
							event: { exceptionDetails: { text: "bad things" } },
						}),
						session_id: "s1",
					},
					{
						id: 1,
						ts: 2001,
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

		const result = await timelineTable.fetch(
			{ type: "comparison", column: "include", op: "=", value: "errors" },
			timelineExecutor as unknown as Parameters<typeof timelineTable.fetch>[1],
		);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0][7]).toBe("error");
		expect(result.rows[0][12]).toBe("errors");
	});

	it("supports timeline window anchoring with full detail", async () => {
		const longError = `fatal-${"x".repeat(220)}`;
		const state = createState();
		const { executor } = createExecutor(state);
		const timelineExecutor = {
			...executor,
			getStore: () => ({
				query: () => [
					{
						id: 3,
						ts: 2090,
						source: "daemon",
						category: "daemon",
						method: "heartbeat",
						data: "{}",
						session_id: "s1",
					},
					{
						id: 2,
						ts: 2050,
						source: "cdp_recv",
						category: "cdp",
						method: "Runtime.exceptionThrown",
						data: JSON.stringify({
							event: { exceptionDetails: { text: longError } },
						}),
						session_id: "s1",
					},
					{
						id: 1,
						ts: 2000,
						source: "daemon",
						category: "daemon",
						method: "health.tick",
						data: "{}",
						session_id: "s1",
					},
				],
			}),
		};

		const result = await timelineTable.fetch(
			{
				type: "and",
				left: { type: "comparison", column: "detail", op: "=", value: "full" },
				right: { type: "comparison", column: "window_ms", op: "=", value: 30 },
			},
			timelineExecutor as unknown as Parameters<typeof timelineTable.fetch>[1],
		);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0][7]).toBe("error");
		expect(result.rows[0][11]).toBe("full");
		expect(result.rows[0][13]).toBe(30);
		expect(String(result.rows[0][6]).length).toBeGreaterThan(160);
	});

	it("registers all expected tables in the registry", () => {
		const expected = [
			"frames",
			"scopes",
			"vars",
			"this",
			"props",
			"proto",
			"breakpoints",
			"scripts",
			"source",
			"console",
			"exceptions",
			"async_frames",
			"listeners",
			"events",
			"cdp",
			"cdp_messages",
			"connections",
			"network",
			"network_headers",
			"network_body",
			"page_events",
			"dom",
			"styles",
			"performance",
			"cookies",
			"storage",
			"ws_frames",
			"coverage",
			"timeline",
			"heap_profiler",
			"cpu_profiler",
			"memory",
			"tracing",
			"accessibility",
			"indexeddb",
			"cache_storage",
			"service_worker",
			"dom_debugger",
			"dom_snapshot",
			"animation",
			"security",
			"media",
			"layer_tree",
		];
		const registry = new TableRegistry();
		registerCoreTables(registry);
		registerBrowserTables(registry);
		const tables = registry.listTables();
		expect(tables).toHaveLength(expected.length);
		for (const name of expected) {
			expect(tables).toContain(name);
			expect(registry.getTable(name)?.name).toBe(name);
		}
		expect(registry.getTable("nope")).toBeUndefined();
	});
});
