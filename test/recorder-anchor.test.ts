// Phase 3 unit tests: `dbg after` anchor spec parsing + anchor capture
// resolution (pure functions, no store/page needed).

import { describe, expect, it } from "vitest";
import {
	type AnchorCaptureRow,
	type AnchorEpochRow,
	parseAnchorSpec,
	resolveAnchor,
} from "../packages/cli/src/recorder/anchor.js";

function capture(
	id: number,
	ts: number,
	changedFiles: string[] = [],
): AnchorCaptureRow {
	return {
		id,
		ts,
		url: `http://x/${id}`,
		scrollY: 0,
		pngPath: `/tmp/${id}.png`,
		changedFiles,
	};
}

const CAPTURES = [
	capture(1, 1000),
	capture(2, 2000, ["src/App.tsx"]),
	capture(3, 3000),
];
const EPOCHS: AnchorEpochRow[] = [
	{ id: 1, ts: 1500, name: null },
	{ id: 2, ts: 2500, name: "checkpoint" },
];

describe("parseAnchorSpec", () => {
	it("parses each kind", () => {
		expect(parseAnchorSpec("capture:7")).toEqual({ kind: "capture", id: 7 });
		expect(parseAnchorSpec("mark:checkpoint")).toEqual({
			kind: "mark",
			name: "checkpoint",
		});
		expect(parseAnchorSpec("time:1712345678901")).toEqual({
			kind: "time",
			ts: 1712345678901,
		});
		expect(parseAnchorSpec("time:2026-07-06T00:00:00Z")).toEqual({
			kind: "time",
			ts: Date.parse("2026-07-06T00:00:00Z"),
		});
		// relative times, resolved against an injected "now"
		expect(parseAnchorSpec("time:10m", 1_000_000_000)).toEqual({
			kind: "time",
			ts: 1_000_000_000 - 600_000,
		});
		expect(parseAnchorSpec("time:30s", 1_000_000_000)).toEqual({
			kind: "time",
			ts: 1_000_000_000 - 30_000,
		});
		expect(parseAnchorSpec("time:2h", 1_000_000_000)).toEqual({
			kind: "time",
			ts: 1_000_000_000 - 7_200_000,
		});
		expect(parseAnchorSpec("file:src/App.tsx")).toEqual({
			kind: "file",
			path: "src/App.tsx",
		});
	});

	it("defaults when omitted or blank", () => {
		expect(parseAnchorSpec(undefined)).toEqual({ kind: "default" });
		expect(parseAnchorSpec("  ")).toEqual({ kind: "default" });
	});

	it("rejects malformed specs", () => {
		expect(parseAnchorSpec("nonsense")).toHaveProperty("error");
		expect(parseAnchorSpec("frame:1")).toHaveProperty("error");
		expect(parseAnchorSpec("capture:abc")).toHaveProperty("error");
		expect(parseAnchorSpec("mark:")).toHaveProperty("error");
		expect(parseAnchorSpec("time:not-a-date")).toHaveProperty("error");
		expect(parseAnchorSpec("file:")).toHaveProperty("error");
		expect(parseAnchorSpec(":x")).toHaveProperty("error");
	});
});

describe("resolveAnchor", () => {
	it("capture: exact id, null when missing", () => {
		expect(
			resolveAnchor({ kind: "capture", id: 2 }, CAPTURES, EPOCHS)?.id,
		).toBe(2);
		expect(resolveAnchor({ kind: "capture", id: 9 }, CAPTURES, EPOCHS)).toBe(
			null,
		);
	});

	it("mark: last capture at/before the named epoch", () => {
		expect(
			resolveAnchor({ kind: "mark", name: "checkpoint" }, CAPTURES, EPOCHS)?.id,
		).toBe(2);
		expect(
			resolveAnchor({ kind: "mark", name: "missing" }, CAPTURES, EPOCHS),
		).toBe(null);
	});

	it("time: last capture at/before ts; first capture when earlier than all", () => {
		expect(
			resolveAnchor({ kind: "time", ts: 2500 }, CAPTURES, EPOCHS)?.id,
		).toBe(2);
		expect(
			resolveAnchor({ kind: "time", ts: 3000 }, CAPTURES, EPOCHS)?.id,
		).toBe(3);
		expect(resolveAnchor({ kind: "time", ts: 1 }, CAPTURES, EPOCHS)?.id).toBe(
			1,
		);
	});

	it("file: the capture before the first capture carrying the file", () => {
		expect(
			resolveAnchor({ kind: "file", path: "src/App.tsx" }, CAPTURES, EPOCHS)
				?.id,
		).toBe(1);
		// carried by the first capture -> degrades to that capture
		expect(
			resolveAnchor(
				{ kind: "file", path: "a.ts" },
				[capture(1, 1000, ["a.ts"]), capture(2, 2000)],
				[],
			)?.id,
		).toBe(1);
		expect(
			resolveAnchor({ kind: "file", path: "nope.ts" }, CAPTURES, EPOCHS),
		).toBe(null);
	});

	it("default: last capture at/before latest epoch; first capture without epochs", () => {
		expect(resolveAnchor({ kind: "default" }, CAPTURES, EPOCHS)?.id).toBe(2);
		expect(resolveAnchor({ kind: "default" }, CAPTURES, [])?.id).toBe(1);
	});

	it("returns null with no captures", () => {
		expect(resolveAnchor({ kind: "default" }, [], EPOCHS)).toBe(null);
	});
});
