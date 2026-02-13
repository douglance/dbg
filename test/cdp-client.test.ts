import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClientWrapper } from "../packages/adapter-cdp/src/client.js";
import { createState } from "./helpers.js";

class FakeClient extends EventEmitter {
	send = vi.fn(async () => ({}));
	close = vi.fn(async () => {});
	Debugger = {
		enable: vi.fn(async () => {}),
		disable: vi.fn(async () => {}),
		pause: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		stepOver: vi.fn(async () => {}),
		stepInto: vi.fn(async () => {}),
		stepOut: vi.fn(async () => {}),
		setBreakpoint: vi.fn(async () => ({
			breakpointId: "bp",
			actualLocation: { scriptId: "s1", lineNumber: 1, columnNumber: 0 },
		})),
		removeBreakpoint: vi.fn(async () => {}),
		getScriptSource: vi.fn(async () => ({ scriptSource: "" })),
		evaluateOnCallFrame: vi.fn(async () => ({
			result: { type: "string", value: "" },
		})),
	};
	Runtime = {
		enable: vi.fn(async () => {}),
		disable: vi.fn(async () => {}),
		evaluate: vi.fn(async () => ({ result: { type: "string", value: "" } })),
	};
}

describe("cdp client wrapper", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("forwards send and throws when not connected", async () => {
		const wrapper = new CdpClientWrapper(createState());
		await expect(wrapper.send("Runtime.evaluate")).rejects.toThrow(
			"not connected",
		);

		const client = new FakeClient();
		(wrapper as any).client = client;
		await wrapper.send("Runtime.evaluate", { expression: "1+1" });
		expect(client.send).toHaveBeenCalledWith("Runtime.evaluate", {
			expression: "1+1",
		});
	});

	it("waitForPaused resolves on event and times out", async () => {
		const wrapper = new CdpClientWrapper(createState());
		await expect(wrapper.waitForPaused(10)).rejects.toThrow("not connected");

		const client = new FakeClient();
		(wrapper as any).client = client;

		const resolved = wrapper.waitForPaused(1000);
		client.emit("Debugger.paused", {});
		await expect(resolved).resolves.toBeUndefined();

		vi.useFakeTimers();
		const timedOut = expect(wrapper.waitForPaused(25)).rejects.toThrow(
			"timeout waiting for pause",
		);
		await vi.advanceTimersByTimeAsync(25);
		await timedOut;
	});

	it("updates state for debugger/runtime events", () => {
		const state = createState({
			scripts: new Map([
				[
					"s1",
					{
						id: "s1",
						file: "/abs/main.ts",
						url: "file:///abs/main.ts",
						lines: 20,
						sourceMap: "",
						isModule: true,
					},
				],
			]),
		});
		const wrapper = new CdpClientWrapper(state);
		const client = new FakeClient();
		(wrapper as any).client = client;
		(wrapper as any).setupEventHandlers();

		client.emit("Debugger.scriptParsed", {
			scriptId: "s2",
			url: "file:///abs/other.ts",
			startLine: 0,
			endLine: 4,
			sourceMapURL: "other.map",
			isModule: false,
		});
		client.emit("Debugger.scriptParsed", {
			scriptId: "skip",
			url: "",
			startLine: 0,
			endLine: 0,
		});
		expect(state.scripts.get("s2")).toMatchObject({
			file: "/abs/other.ts",
			lines: 5,
			sourceMap: "other.map",
		});
		expect(state.scripts.has("skip")).toBe(false);

		client.emit("Debugger.paused", {
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "",
					location: { scriptId: "s1", lineNumber: 3, columnNumber: 2 },
					url: "file:///abs/main.ts",
					scopeChain: [
						{ type: "local", name: "Local", object: { objectId: "scope-1" } },
					],
					this: { objectId: "this-1" },
				},
			],
			asyncStackTrace: {
				description: "await",
				callFrames: [
					{
						functionName: "",
						url: "file:///abs/async.ts",
						lineNumber: 8,
						columnNumber: 0,
						scriptId: "s3",
					},
				],
				parent: {
					description: "parent",
					callFrames: [
						{
							functionName: "parentFn",
							url: "file:///abs/parent.ts",
							lineNumber: 2,
							columnNumber: 0,
							scriptId: "s4",
						},
					],
				},
			},
		});

		expect(state.paused).toBe(true);
		expect(state.callFrames[0]).toMatchObject({
			functionName: "(anonymous)",
			file: "/abs/main.ts",
			line: 3,
			col: 2,
			thisObjectId: "this-1",
		});
		expect(state.asyncStackTrace).toHaveLength(2);
		expect(state.asyncStackTrace[0]).toMatchObject({
			functionName: "(anonymous)",
			file: "/abs/async.ts",
			description: "await",
		});
		expect(state.asyncStackTrace[1]).toMatchObject({
			functionName: "parentFn",
			description: "parent",
		});

		client.emit("Runtime.consoleAPICalled", {
			type: "log",
			args: [
				{ type: "string", value: "hi" },
				{ type: "object", description: "Object" },
			],
			timestamp: 42,
			stackTrace: { callFrames: [{ url: "file:///x.ts", lineNumber: 6 }] },
		});
		expect(state.console[0]).toEqual({
			id: 1,
			type: "log",
			text: "hi Object",
			ts: 42,
			stack: "file:///x.ts:6",
		});

		client.emit("Runtime.exceptionThrown", {
			timestamp: 99,
			exceptionDetails: {
				text: "Uncaught",
				exception: {
					className: "TypeError",
					description: "TypeError: bad",
				},
				url: "file:///abs/main.ts",
				lineNumber: 11,
			},
		});
		expect(state.exceptions[0]).toEqual({
			id: 1,
			text: "TypeError: bad",
			type: "TypeError",
			file: "/abs/main.ts",
			line: 11,
			ts: 99,
			uncaught: true,
		});

		client.emit("Debugger.resumed");
		expect(state.paused).toBe(false);
		expect(state.callFrames).toEqual([]);
		expect(state.asyncStackTrace).toEqual([]);
	});

	it("stores network duration in milliseconds", () => {
		const state = createState();
		const wrapper = new CdpClientWrapper(state);
		const client = new FakeClient();
		(wrapper as any).client = client;
		(wrapper as any).setupEventHandlers();

		client.emit("Network.requestWillBeSent", {
			requestId: "r1",
			request: {
				url: "https://example.com/app.js",
				method: "GET",
				headers: {},
			},
			timestamp: 1.25,
			initiator: { type: "script" },
		});
		client.emit("Network.loadingFinished", {
			requestId: "r1",
			timestamp: 1.75,
			encodedDataLength: 1024,
		});

		expect(state.cdp?.networkRequests.get("r1")?.duration).toBe(500);
	});

	it("skips duplicate .undefined CDP event variants", () => {
		const state = createState();
		const record = vi.fn();
		const wrapper = new CdpClientWrapper(state, { record } as any);
		const client = new FakeClient();
		(wrapper as any).client = client;
		(wrapper as any).setupEventHandlers();

		const payload = {
			scriptId: "s2",
			url: "file:///abs/other.ts",
			startLine: 0,
			endLine: 4,
		};
		client.emit("Debugger.scriptParsed.undefined", payload);
		client.emit("Debugger.scriptParsed", payload);

		const cdpRecvCalls = record.mock.calls.filter(
			([event]) => event?.category === "cdp" && event?.source === "cdp_recv",
		);
		expect(cdpRecvCalls).toHaveLength(1);
		expect(cdpRecvCalls[0][0].method).toBe("Debugger.scriptParsed");
	});

	it("disconnect resets state and tolerates close errors", async () => {
		const state = createState({
			connected: true,
			paused: true,
			callFrames: [
				{
					callFrameId: "cf-1",
					functionName: "f",
					url: "",
					file: "f.ts",
					line: 1,
					col: 0,
					scriptId: "s1",
					scopeChain: [],
					thisObjectId: "",
				},
			],
			asyncStackTrace: [
				{
					id: 1,
					functionName: "af",
					file: "af.ts",
					line: 1,
					parentId: null,
					description: "",
				},
			],
		});
		const wrapper = new CdpClientWrapper(state);
		const client = new FakeClient();
		client.close.mockRejectedValueOnce(new Error("socket gone"));
		(wrapper as any).client = client;

		await wrapper.disconnect();

		expect(wrapper.getClient()).toBeNull();
		expect(state.connected).toBe(false);
		expect(state.paused).toBe(false);
		expect(state.callFrames).toEqual([]);
		expect(state.asyncStackTrace).toEqual([]);
	});

	it("isConnected depends on both client and state flag", () => {
		const state = createState({ connected: false });
		const wrapper = new CdpClientWrapper(state);
		const client = new FakeClient();

		expect(wrapper.isConnected()).toBe(false);

		(wrapper as any).client = client;
		expect(wrapper.isConnected()).toBe(false);

		state.connected = true;
		expect(wrapper.isConnected()).toBe(true);
	});
});
