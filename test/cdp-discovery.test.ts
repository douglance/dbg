import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverTarget } from "../src/cdp/discovery.js";

interface MockReq extends EventEmitter {
	setTimeout: (ms: number, cb: () => void) => void;
	destroy: () => void;
}

function mockHttpWithBody(body: string): MockReq {
	const req = new EventEmitter() as MockReq;
	req.destroy = vi.fn();
	req.setTimeout = vi.fn();

	vi.spyOn(http, "get").mockImplementation(
		(_url: string, cb: (res: EventEmitter) => void) => {
			const res = new EventEmitter();
			cb(res);
			queueMicrotask(() => {
				res.emit("data", Buffer.from(body, "utf8"));
				res.emit("end");
			});
			return req as any;
		},
	);
	return req;
}

describe("cdp discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns websocket url for node target", async () => {
		mockHttpWithBody(
			JSON.stringify([
				{ type: "page", webSocketDebuggerUrl: "ws://page" },
				{ type: "node", webSocketDebuggerUrl: "ws://node-target" },
			]),
		);
		await expect(discoverTarget(9229)).resolves.toEqual({
			wsUrl: "ws://node-target",
			type: "node",
		});
	});

	it("falls back to page target when no node target exists", async () => {
		mockHttpWithBody(
			JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://page" }]),
		);
		await expect(discoverTarget(9229, "localhost")).resolves.toEqual({
			wsUrl: "ws://page",
			type: "page",
		});
	});

	it("errors when explicit node type requested but only page exists", async () => {
		mockHttpWithBody(
			JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://page" }]),
		);
		await expect(discoverTarget(9229, "localhost", "node")).rejects.toThrow(
			"no debuggable node target on localhost:9229",
		);
	});

	it("errors when /json body cannot be parsed", async () => {
		mockHttpWithBody("{bad json");
		await expect(discoverTarget(9229)).rejects.toThrow(
			"failed to parse /json response",
		);
	});

	it("maps request errors to connection error", async () => {
		const req = new EventEmitter() as MockReq;
		req.destroy = vi.fn();
		req.setTimeout = vi.fn();
		vi.spyOn(http, "get").mockImplementation(
			(_url: string, _cb: (res: EventEmitter) => void) => {
				queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED")));
				return req as any;
			},
		);

		await expect(discoverTarget(9229, "10.0.0.5")).rejects.toThrow(
			"cannot reach debugger at 10.0.0.5:9229: ECONNREFUSED",
		);
	});

	it("times out when request timeout triggers", async () => {
		const req = new EventEmitter() as MockReq;
		req.destroy = vi.fn();
		req.setTimeout = vi.fn((_, cb) => {
			queueMicrotask(cb);
		});

		vi.spyOn(http, "get").mockImplementation(
			(_url: string, _cb: (res: EventEmitter) => void) => req as any,
		);

		await expect(discoverTarget(9229)).rejects.toThrow(
			"timeout connecting to 127.0.0.1:9229",
		);
		expect(req.destroy).toHaveBeenCalled();
	});
});
