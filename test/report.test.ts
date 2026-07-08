import { describe, expect, it } from "vitest";
import {
	type ReportInput,
	renderReport,
	renderTimeline,
	type TimelineInput,
} from "../packages/report/src/index.js";

const beforePng = Buffer.from("before-image-bytes-0000");
const afterPng = Buffer.from("after-image-bytes-11111");
const diffPng = Buffer.from("diff-image-bytes-222222");

const stats = {
	diffPixels: 400,
	totalPixels: 10000,
	diffPercent: 4,
	width: 100,
	height: 100,
	dimensionsChanged: false,
};

function makeReportInput(): ReportInput {
	return {
		pairs: [
			{
				name: "home",
				beforePng,
				afterPng,
				diffPng,
				stats,
				regions: [{ box: { x: 10, y: 10, w: 20, h: 20 }, label: "<Header>" }],
				styleChanges: [
					{ selector: ".btn", prop: "padding", before: "4px", after: "8px" },
				],
				newErrors: [
					{
						type: "error",
						text: "Cannot read properties of undefined",
						ts: 1720000000000,
					},
				],
				newNetworkFailures: [
					{ url: "/api/session", status: 500, ts: 1720000000001 },
				],
			},
		],
		meta: { generatedAt: "2026-07-06T00:00:00.000Z", anchor: "capture:42" },
	};
}

describe("renderReport", () => {
	it("inlines all three PNGs as base64 data URIs per pair", () => {
		const html = renderReport(makeReportInput());
		expect(html).toContain(beforePng.toString("base64"));
		expect(html).toContain(afterPng.toString("base64"));
		expect(html).toContain(diffPng.toString("base64"));
		const uris = html.match(/data:image\/png;base64,/g) ?? [];
		expect(uris.length).toBeGreaterThanOrEqual(3);
	});

	it("contains the four view modes with slider markup", () => {
		const html = renderReport(makeReportInput());
		expect(html).toContain('data-view="sbs"');
		expect(html).toContain('data-view="wipe"');
		expect(html).toContain('data-view="onion"');
		expect(html).toContain('data-view="diff"');
		expect(html).toContain('type="range"');
		expect(html).toContain("wipe-range");
		expect(html).toContain("onion-range");
		expect(html).toContain("clip-path");
	});

	it("renders escaped region labels, style changes, and error text", () => {
		const html = renderReport(makeReportInput());
		expect(html).toContain("&lt;Header&gt;");
		expect(html).not.toContain("<Header>");
		expect(html).toContain("padding");
		expect(html).toContain(".btn");
		expect(html).toContain("Cannot read properties of undefined");
		expect(html).toContain("/api/session");
		expect(html).toContain("capture:42");
	});

	it("has no external http(s) references (CSP-safe)", () => {
		const html = renderReport(makeReportInput());
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toContain("@import");
	});

	it("renders multiple pairs and the dimensions-changed badge", () => {
		const input = makeReportInput();
		input.pairs.push({
			name: "settings",
			beforePng,
			afterPng,
			diffPng,
			stats: { ...stats, dimensionsChanged: true },
		});
		const html = renderReport(input);
		expect(html).toContain("home");
		expect(html).toContain("settings");
		expect(html).toContain("dimensions changed");
		const uris = html.match(/data:image\/png;base64,/g) ?? [];
		expect(uris.length).toBeGreaterThanOrEqual(6);
	});
});

function makeTimelineInput(): TimelineInput {
	return {
		frames: [
			{
				id: 7,
				ts: 1720000000000,
				thumbPng: Buffer.from("thumb-a"),
				url: "/",
				changedFiles: ["src/App.tsx"],
				hmrModules: ["/src/App.tsx"],
				epochName: "epoch-1",
				logCounts: { error: 2, log: 5 },
			},
			{
				ts: 1720000005000,
				thumbPng: Buffer.from("thumb-b"),
				url: "/settings",
				changedFiles: ["src/Settings.tsx"],
			},
		],
		meta: { generatedAt: "2026-07-06T00:00:00.000Z" },
	};
}

describe("renderTimeline", () => {
	it("inlines each frame thumbnail and its annotations", () => {
		const html = renderTimeline(makeTimelineInput());
		expect(html).toContain(Buffer.from("thumb-a").toString("base64"));
		expect(html).toContain(Buffer.from("thumb-b").toString("base64"));
		expect(html).toContain("src/App.tsx");
		expect(html).toContain("src/Settings.tsx");
		expect(html).toContain("epoch-1");
		expect(html).toContain("error×2");
		expect(html).toContain("/settings");
	});

	it("uses frame id (falling back to ts) and surfaces the dbg after command", () => {
		const html = renderTimeline(makeTimelineInput());
		expect(html).toContain('data-id="7"');
		expect(html).toContain('data-id="1720000005000"'); // id fallback = ts
		expect(html).toContain("dbg after --at capture:");
		expect(html).toContain("Diff these two");
	});

	it("has no external http(s) references (CSP-safe)", () => {
		const html = renderTimeline(makeTimelineInput());
		expect(html).not.toMatch(/https?:\/\//);
	});
});
