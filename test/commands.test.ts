import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleContinue,
	handleDeleteBreakpoint,
	handleEval,
	handleListBreakpoints,
	handlePause,
	handleReconnect,
	handleSetBreakpoint,
	handleSource,
	handleStatus,
	handleStepInto,
	handleStepOut,
	handleStepOver,
} from "../packages/cli/src/commands.js";
import { DAP_CAPABILITIES } from "../packages/types/src/index.js";
import type {
	DaemonState,
	StoredBreakpoint,
} from "../packages/types/src/index.js";
import { EventStore } from "../packages/store/src/index.js";
import { createMockCdp, createState } from "./helpers.js";

describe("commands", () => {
	let state: DaemonState;
	let cdp: ReturnType<typeof createMockCdp>;
	let cdpClient: Parameters<typeof handleStatus>[0];

	beforeEach(() => {
		state = createState();
		cdp = createMockCdp();
		cdpClient = cdp as unknown as Parameters<typeof handleStatus>[0];
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns disconnected status when not connected", async () => {
		state.pid = 77;
		const result = await handleStatus(cdpClient, state);
		expect(result).toEqual({
			ok: true,
			connected: false,
			status: undefined,
			pid: 77,
		});
	});

	it("returns paused location in status when connected", async () => {
		state.connected = true;
		state.paused = true;
		state.callFrames = [
			{
				callFrameId: "cf-1",
				functionName: "main",
				url: "file:///app.ts",
				file: "/app.ts",
				line: 12,
				col: 3,
				scriptId: "s1",
				scopeChain: [],
				thisObjectId: "",
			},
		];

		const result = await handleStatus(cdpClient, state);
		expect(result).toMatchObject({
			ok: true,
			connected: true,
			status: "paused",
			file: "/app.ts",
			line: 12,
			function: "main",
		});
	});

	it("passes target type through reconnect", async () => {
		if (state.cdp) {
			state.cdp.lastWsUrl = "ws://127.0.0.1:9229/devtools/page/1";
		}
		const reconnectCdp = {
			disconnect: vi.fn(async () => {}),
			connect: vi.fn(async () => {}),
		} as unknown as Parameters<typeof handleReconnect>[0];
		const store = new EventStore();

		const result = await handleReconnect(reconnectCdp, state, store, "page");
		expect(result).toMatchObject({
			ok: true,
			connected: true,
			messages: ["reconnected"],
		});
		expect((reconnectCdp as any).disconnect).toHaveBeenCalledTimes(1);
		expect((reconnectCdp as any).connect).toHaveBeenCalledWith(
			"ws://127.0.0.1:9229/devtools/page/1",
			"page",
		);
	});

	it("returns running when continue does not pause again in time", async () => {
		vi.useFakeTimers();
		state.connected = true;
		state.paused = true;
		cdp.waitForPaused.mockReturnValue(new Promise(() => {}));

		const pending = handleContinue(cdpClient, state);
		await vi.advanceTimersByTimeAsync(5000);

		await expect(pending).resolves.toEqual({ ok: true, status: "running" });
		expect(cdp.send).toHaveBeenCalledWith("Debugger.resume");
	});

	it("fails fast when dap session is terminated", async () => {
		state.connected = true;
		state.paused = true;
		if (state.dap) {
			state.dap.phase = "terminated";
		}
		const dapExecutor = {
			protocol: "dap" as const,
			capabilities: DAP_CAPABILITIES,
			send: vi.fn(async () => ({})),
			waitForPaused: vi.fn(async () => {}),
			getState: vi.fn(() => state),
			getPhase: vi.fn(() => "terminated" as const),
			getLastError: vi.fn(() => null),
		} as unknown as Parameters<typeof handleContinue>[0];

		const result = await handleContinue(dapExecutor, state);
		expect(result).toEqual({
			ok: false,
			error: "dap session is terminated",
			errorCode: "DAP_SESSION_TERMINATED",
			phase: "terminated",
		});
	});

	it("returns dap error details when phase is error", async () => {
		state.connected = true;
		state.paused = true;
		if (state.dap) {
			state.dap.phase = "error";
			state.dap.lastError = {
				code: "DAP_PROCESS_EXITED",
				message: "dap process exited",
				timestamp: Date.now(),
			};
		}
		const dapExecutor = {
			protocol: "dap" as const,
			capabilities: DAP_CAPABILITIES,
			send: vi.fn(async () => ({})),
			waitForPaused: vi.fn(async () => {}),
			getState: vi.fn(() => state),
			getPhase: vi.fn(() => "error" as const),
			getLastError: vi.fn(() => ({
				code: "DAP_PROCESS_EXITED",
				message: "dap process exited",
			})),
		} as unknown as Parameters<typeof handleStepOver>[0];

		const result = await handleStepOver(dapExecutor, state);
		expect(result).toEqual({
			ok: false,
			error: "dap process exited",
			errorCode: "DAP_PROCESS_EXITED",
			phase: "error",
		});
	});

	it("returns paused location after continue pauses again", async () => {
		state.connected = true;
		state.paused = true;
		state.callFrames = [
			{
				callFrameId: "cf-1",
				functionName: "run",
				url: "file:///run.ts",
				file: "/run.ts",
				line: 8,
				col: 0,
				scriptId: "s1",
				scopeChain: [],
				thisObjectId: "",
			},
		];

		const result = await handleContinue(cdpClient, state);
		expect(result).toMatchObject({
			ok: true,
			status: "paused",
			file: "/run.ts",
			line: 8,
			function: "run",
		});
		expect(cdp.send).toHaveBeenCalledWith("Debugger.resume");
	});

	it("uses expected CDP methods for stepping commands", async () => {
		state.connected = true;
		state.paused = true;
		state.callFrames = [
			{
				callFrameId: "cf-1",
				functionName: "f",
				url: "file:///f.ts",
				file: "/f.ts",
				line: 1,
				col: 0,
				scriptId: "s1",
				scopeChain: [],
				thisObjectId: "",
			},
		];

		await handleStepInto(cdpClient, state);
		await handleStepOver(cdpClient, state);
		await handleStepOut(cdpClient, state);

		expect(cdp.send).toHaveBeenNthCalledWith(1, "Debugger.stepInto");
		expect(cdp.send).toHaveBeenNthCalledWith(2, "Debugger.stepOver");
		expect(cdp.send).toHaveBeenNthCalledWith(3, "Debugger.stepOut");
	});

	it("pauses execution when connected and running", async () => {
		state.connected = true;
		state.paused = false;
		state.callFrames = [
			{
				callFrameId: "cf-1",
				functionName: "loop",
				url: "file:///loop.ts",
				file: "/loop.ts",
				line: 9,
				col: 0,
				scriptId: "s1",
				scopeChain: [],
				thisObjectId: "",
			},
		];

		const result = await handlePause(cdpClient, state);
		expect(result).toMatchObject({
			ok: true,
			status: "paused",
			file: "/loop.ts",
			line: 9,
		});
		expect(cdp.send).toHaveBeenCalledWith("Debugger.pause");
	});

	it("rejects invalid breakpoint arguments", async () => {
		state.connected = true;
		await expect(
			handleSetBreakpoint(cdpClient, state, "main.ts"),
		).resolves.toEqual({
			ok: false,
			error: "expected file:line",
		});
		await expect(
			handleSetBreakpoint(cdpClient, state, "main.ts:abc"),
		).resolves.toEqual({
			ok: false,
			error: "invalid line number",
		});
	});

	it("sets breakpoint with matched script and condition", async () => {
		state.connected = true;
		state.scripts.set("s1", {
			id: "s1",
			file: "/src/main.ts",
			url: "file:///workspace/src/main.ts",
			lines: 40,
			sourceMap: "",
			isModule: true,
		});
		cdp.send.mockResolvedValue({
			breakpointId: "bp-1",
			locations: [{ scriptId: "s1", lineNumber: 11, columnNumber: 0 }],
		});

		const result = await handleSetBreakpoint(
			cdpClient,
			state,
			"main.ts:10 if count > 0",
		);

		expect(cdp.send).toHaveBeenCalledWith("Debugger.setBreakpointByUrl", {
			lineNumber: 10,
			urlRegex: "file:///workspace/src/main\\.ts",
			columnNumber: 0,
			condition: "count > 0",
		});
		expect(result).toEqual({
			ok: true,
			id: "bp-1",
			file: "/src/main.ts",
			line: 11,
		});
		expect(state.breakpoints.get("bp-1")).toMatchObject({
			id: "bp-1",
			file: "/src/main.ts",
			line: 11,
			condition: "count > 0",
		});
	});

	it("falls back to filename regex when script is unknown", async () => {
		state.connected = true;
		cdp.send.mockResolvedValue({
			breakpointId: "bp-2",
			locations: [],
		});

		await handleSetBreakpoint(cdpClient, state, "foo.ts:3");

		expect(cdp.send).toHaveBeenCalledWith("Debugger.setBreakpointByUrl", {
			lineNumber: 3,
			urlRegex: ".*foo\\.ts$",
			columnNumber: 0,
		});
	});

	it("deletes breakpoint via CDP and state map", async () => {
		state.connected = true;
		const bp: StoredBreakpoint = {
			id: "bp-1",
			file: "main.ts",
			line: 1,
			condition: "",
			hits: 0,
			enabled: true,
			cdpBreakpointId: "cdp-bp-1",
		};
		state.breakpoints.set("bp-1", bp);

		const result = await handleDeleteBreakpoint(cdpClient, state, "bp-1");
		expect(result).toEqual({ ok: true, id: "bp-1" });
		expect(cdp.send).toHaveBeenCalledWith("Debugger.removeBreakpoint", {
			breakpointId: "cdp-bp-1",
		});
		expect(state.breakpoints.has("bp-1")).toBe(false);
	});

	it("lists breakpoints in table response format", async () => {
		state.breakpoints.set("bp-1", {
			id: "bp-1",
			file: "a.ts",
			line: 2,
			condition: "x > 1",
			hits: 3,
			enabled: true,
			cdpBreakpointId: "bp-1",
		});
		const result = await handleListBreakpoints(cdpClient, state);

		expect(result).toEqual({
			ok: true,
			columns: ["id", "file", "line", "condition", "hits"],
			rows: [["bp-1", "a.ts", 2, "x > 1", 3]],
		});
	});

	it("evaluates on call frame when paused and runtime when running", async () => {
		state.connected = true;
		state.paused = true;
		state.callFrames = [
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
		];
		cdp.send.mockResolvedValueOnce({
			result: { type: "object", value: { ok: true } },
		});
		cdp.send.mockResolvedValueOnce({
			result: { type: "number", value: 42 },
		});

		const paused = await handleEval(cdpClient, state, "obj");
		expect(paused).toEqual({ ok: true, value: '{"ok":true}', type: "object" });
		expect(cdp.send).toHaveBeenNthCalledWith(
			1,
			"Debugger.evaluateOnCallFrame",
			{
				callFrameId: "cf-1",
				expression: "obj",
				returnByValue: true,
			},
		);

		state.paused = false;
		state.callFrames = [];
		const running = await handleEval(cdpClient, state, "x");
		expect(running).toEqual({ ok: true, value: "42", type: "number" });
		expect(cdp.send).toHaveBeenNthCalledWith(2, "Runtime.evaluate", {
			expression: "x",
			returnByValue: true,
		});
	});

	it("returns eval error when exception details are present", async () => {
		state.connected = true;
		cdp.send.mockResolvedValue({
			result: { type: "string", value: "" },
			exceptionDetails: { text: "ReferenceError" },
		});

		const result = await handleEval(cdpClient, state, "missingVar");
		expect(result).toEqual({ ok: false, error: "ReferenceError" });
	});

	it("loads source around current frame and from explicit range", async () => {
		state.connected = true;
		state.paused = true;
		state.callFrames = [
			{
				callFrameId: "cf-1",
				functionName: "f",
				url: "",
				file: "main.ts",
				line: 1,
				col: 0,
				scriptId: "s1",
				scopeChain: [],
				thisObjectId: "",
			},
		];
		state.scripts.set("s1", {
			id: "s1",
			file: "main.ts",
			url: "file:///main.ts",
			lines: 3,
			sourceMap: "",
			isModule: false,
		});
		cdp.send.mockResolvedValue({
			scriptSource: "zero\none\ntwo",
		});

		const around = await handleSource(cdpClient, state);
		expect(around).toEqual({
			ok: true,
			value: "0\tzero\n1>\tone\n2\ttwo",
		});

		const explicit = await handleSource(cdpClient, state, "main.ts 0 1");
		expect(explicit).toEqual({
			ok: true,
			value: "0\tzero\n1\tone",
		});
	});

	it("validates source arguments and unknown file lookups", async () => {
		state.connected = true;
		state.paused = false;

		await expect(handleSource(cdpClient, state)).resolves.toEqual({
			ok: false,
			error: "not paused; specify file start end",
		});
		await expect(handleSource(cdpClient, state, "main.ts 1")).resolves.toEqual({
			ok: false,
			error: "expected: file startLine endLine",
		});
		await expect(
			handleSource(cdpClient, state, "missing.ts 1 2"),
		).resolves.toEqual({
			ok: false,
			error: 'no script matching "missing.ts"',
		});
	});
});
