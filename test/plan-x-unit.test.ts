// Plan X unit coverage: the pure perf.ts fns — batch parsing, delta math,
// budget parse/check. No Chrome, no store; synthetic inputs only.

import { describe, expect, it } from "vitest";
import {
	checkPerfBudget,
	computePerfDelta,
	parsePerfBatch,
	parsePerfBudget,
	type PerfSampleRow,
} from "../packages/cli/src/perf.js";

describe("parsePerfBatch", () => {
	it("maps each entry type to its metric and passes ts through", () => {
		const payload = JSON.stringify([
			{ type: "largest-contentful-paint", name: "", ts: 1000, value: 2400 },
			{ type: "layout-shift", name: "", ts: 1010, value: 0.05 },
			{ type: "longtask", name: "self", ts: 1020, value: 120 },
			{ type: "paint", name: "first-contentful-paint", ts: 1030, value: 800 },
			{ type: "paint", name: "first-paint", ts: 1031, value: 780 },
			{ type: "event", name: "pointerdown", ts: 1040, value: 64 },
		]);
		const rows = parsePerfBatch(payload, 3);
		expect(rows.map((r) => r.metric)).toEqual([
			"lcp",
			"cls",
			"longtask",
			"fcp",
			"paint",
			"event",
		]);
		expect(rows.every((r) => r.navId === 3)).toBe(true);
		expect(rows.every((r) => r.captureId === null)).toBe(true);
		expect(rows[0].ts).toBe(1000);
		expect(rows[0].value).toBe(2400);
		// event keeps its name in detail; others are null.
		expect(rows[5].detail).toBe("pointerdown");
		expect(rows[1].detail).toBeNull();
	});

	it("skips entries with a non-numeric ts or value", () => {
		// The injected observer drops hadRecentInput layout-shifts before flushing
		// (never in a batch); here we assert non-numeric fields are skipped.
		const payload = JSON.stringify([
			{ type: "layout-shift", name: "", ts: 10, value: 0.1 },
			{ type: "layout-shift", name: "", ts: "oops", value: 0.2 },
			{ type: "longtask", name: "", ts: 20, value: "nope" },
		]);
		const rows = parsePerfBatch(payload, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0].value).toBe(0.1);
	});

	it("returns [] for malformed JSON or a non-array payload", () => {
		expect(parsePerfBatch("not json", 1)).toEqual([]);
		expect(parsePerfBatch("{}", 1)).toEqual([]);
		expect(parsePerfBatch("", 1)).toEqual([]);
	});
});

describe("computePerfDelta", () => {
	const anchorTs = 1000;
	const afterTs = 2000;
	const anchorCap = 10;
	const afterCap = 20;

	const samples: PerfSampleRow[] = [
		// cls before the anchor (baseline) and after (new shift during flows).
		{
			ts: 900,
			navId: 1,
			captureId: null,
			metric: "cls",
			value: 0.02,
			detail: null,
		},
		{
			ts: 1500,
			navId: 1,
			captureId: null,
			metric: "cls",
			value: 0.08,
			detail: null,
		},
		{
			ts: 1600,
			navId: 1,
			captureId: null,
			metric: "cls",
			value: 0.04,
			detail: null,
		},
		// a longtask before and two after.
		{
			ts: 950,
			navId: 1,
			captureId: null,
			metric: "longtask",
			value: 60,
			detail: null,
		},
		{
			ts: 1400,
			navId: 1,
			captureId: null,
			metric: "longtask",
			value: 120,
			detail: null,
		},
		{
			ts: 1700,
			navId: 1,
			captureId: null,
			metric: "longtask",
			value: 90,
			detail: null,
		},
		// lcp: latest under anchorTs is 2400; latest under afterTs is 2600.
		{
			ts: 800,
			navId: 1,
			captureId: null,
			metric: "lcp",
			value: 2400,
			detail: null,
		},
		{
			ts: 1800,
			navId: 1,
			captureId: null,
			metric: "lcp",
			value: 2600,
			detail: null,
		},
		// interactions (event) in the after window.
		{
			ts: 1450,
			navId: 1,
			captureId: null,
			metric: "event",
			value: 48,
			detail: "click",
		},
		{
			ts: 1650,
			navId: 1,
			captureId: null,
			metric: "event",
			value: 72,
			detail: "keydown",
		},
		// capture-keyed jsHeap + bundle_bytes.
		{
			ts: 1000,
			navId: 1,
			captureId: anchorCap,
			metric: "JSHeapUsedSize",
			value: 1_000_000,
			detail: null,
		},
		{
			ts: 2000,
			navId: 1,
			captureId: afterCap,
			metric: "JSHeapUsedSize",
			value: 1_500_000,
			detail: null,
		},
		{
			ts: 1000,
			navId: 1,
			captureId: anchorCap,
			metric: "bundle_bytes",
			value: 50_000,
			detail: null,
		},
		{
			ts: 2000,
			navId: 1,
			captureId: afterCap,
			metric: "bundle_bytes",
			value: 3_050_000,
			detail: null,
		},
	];

	const delta = computePerfDelta(
		samples,
		anchorCap,
		afterCap,
		anchorTs,
		afterTs,
	);

	it("sums cls only inside the after window", () => {
		expect(delta.cls.anchor).toBeCloseTo(0.02, 5);
		expect(delta.cls.after).toBeCloseTo(0.12, 5);
		expect(delta.cls.delta).toBeCloseTo(0.12, 5);
	});

	it("counts new longtasks in the after window", () => {
		expect(delta.longtasks.newCount).toBe(2);
	});

	it("takes the latest lcp at/under each side", () => {
		expect(delta.lcp.anchor).toBe(2400);
		expect(delta.lcp.after).toBe(2600);
		expect(delta.lcp.delta).toBe(200);
	});

	it("diffs capture-keyed jsHeap and bundle_bytes", () => {
		expect(delta.jsHeap.delta).toBe(500_000);
		expect(delta.bundleBytes.delta).toBe(3_000_000);
	});

	it("reports interaction count and max duration during flows", () => {
		expect(delta.interactions.count).toBe(2);
		expect(delta.interactions.maxDuration).toBe(72);
	});
});

describe("parsePerfBudget / checkPerfBudget", () => {
	it("parses a budget spec and ignores malformed pairs", () => {
		expect(parsePerfBudget("lcp=2500,cls=0.1")).toEqual({
			lcp: 2500,
			cls: 0.1,
		});
		expect(parsePerfBudget("lcp=2500,bogus,cls=,=5,jsheap=abc")).toEqual({
			lcp: 2500,
		});
	});

	it("flags a breach and passes within budget", () => {
		const base = computePerfDelta([], 1, 2, 0, 10);
		const breaching = {
			...base,
			cls: { anchor: 0, after: 0.2, delta: 0.2 },
		};
		expect(checkPerfBudget(breaching, { cls: 0.1 })).toHaveLength(1);
		expect(checkPerfBudget(breaching, { cls: 0.1 })[0]).toContain("cls");
		const within = { ...base, cls: { anchor: 0, after: 0.05, delta: 0.05 } };
		expect(checkPerfBudget(within, { cls: 0.1 })).toEqual([]);
	});
});
