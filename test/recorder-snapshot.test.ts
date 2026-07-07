// Phase 4 unit tests: DOMSnapshot parsing, structural style diff, and
// cluster→component blame regions (pure functions).

import { describe, expect, it } from "vitest";
import type { Box } from "../packages/diff/src/index.js";
import {
	buildRegions,
	type ComponentRect,
	diffSnapshots,
	parseComponentRects,
	parseDomSnapshot,
	type RawDomSnapshot,
} from "../packages/cli/src/recorder/snapshot.js";

const WHITELIST = ["padding-top", "color"];

// #document > html > body > div.color-card + div
function rawSnapshot(cardPaddingIdx: number): RawDomSnapshot {
	return {
		strings: [
			"#document", // 0
			"HTML", // 1
			"BODY", // 2
			"DIV", // 3
			"class", // 4
			"color-card", // 5
			"8px", // 6
			"40px", // 7
			"rgb(0, 0, 0)", // 8
		],
		documents: [
			{
				nodes: {
					parentIndex: [-1, 0, 1, 2, 2],
					nodeType: [9, 1, 1, 1, 1],
					nodeName: [0, 1, 2, 3, 3],
					attributes: [[], [], [], [4, 5], []],
				},
				layout: {
					nodeIndex: [1, 2, 3, 4],
					bounds: [
						[0, 0, 800, 600],
						[0, 0, 800, 600],
						[10, 10, 400, 200],
						[10, 220, 100, 50],
					],
					styles: [
						[6, 8],
						[6, 8],
						[cardPaddingIdx, 8],
						[6, 8],
					],
				},
			},
		],
	};
}

describe("parseDomSnapshot", () => {
	it("builds stable paths, classes, rects, and whitelisted styles", () => {
		const elements = parseDomSnapshot(rawSnapshot(6), WHITELIST);
		expect(elements.length).toBe(4);
		const card = elements.find((e) => e.className === "color-card");
		expect(card).toBeDefined();
		expect(card?.path).toBe(
			"html:nth-of-type(1)>body:nth-of-type(1)>div:nth-of-type(1)",
		);
		expect(card?.rect).toEqual({ x: 10, y: 10, w: 400, h: 200 });
		expect(card?.styles).toEqual({
			"padding-top": "8px",
			color: "rgb(0, 0, 0)",
		});
		// sibling div gets nth-of-type(2)
		expect(elements.some((e) => e.path.endsWith("div:nth-of-type(2)"))).toBe(
			true,
		);
	});

	it("returns [] for malformed input", () => {
		expect(parseDomSnapshot({}, WHITELIST)).toEqual([]);
		expect(parseDomSnapshot({ documents: [], strings: [] })).toEqual([]);
		expect(parseDomSnapshot({ documents: [{}], strings: [] })).toEqual([]);
	});
});

describe("diffSnapshots", () => {
	it("finds the padding delta on the matched node", () => {
		const before = parseDomSnapshot(rawSnapshot(6), WHITELIST);
		const after = parseDomSnapshot(rawSnapshot(7), WHITELIST);
		const changes = diffSnapshots(before, after);
		expect(changes).toEqual([
			{
				selector: "div.color-card",
				prop: "padding-top",
				before: "8px",
				after: "40px",
			},
		]);
	});

	it("caps output and orders biggest element first", () => {
		const before = parseDomSnapshot(rawSnapshot(6), WHITELIST);
		const after = parseDomSnapshot(rawSnapshot(7), WHITELIST).map((e) => ({
			...e,
			styles: { ...e.styles, color: "rgb(255, 0, 0)" },
		}));
		const capped = diffSnapshots(before, after, 2);
		expect(capped.length).toBe(2);
		// biggest element (html/body 800x600) sorts before the card
		expect(capped[0].prop).toBe("color");
	});

	it("ignores unmatched paths", () => {
		const before = parseDomSnapshot(rawSnapshot(6), WHITELIST);
		expect(diffSnapshots(before, [])).toEqual([]);
		expect(diffSnapshots([], before).length).toBe(0);
	});
});

describe("buildRegions", () => {
	const clusters: Box[] = [{ x: 15, y: 15, w: 100, h: 50, pixels: 500 }];
	const body: ComponentRect = {
		tag: "body",
		className: "",
		rect: { x: 0, y: 0, w: 800, h: 600 },
		component: null,
		file: null,
	};
	const card: ComponentRect = {
		tag: "div",
		className: "color-card",
		rect: { x: 10, y: 10, w: 400, h: 200 },
		component: "ColorCard",
		file: "/src/ColorCard.tsx",
	};

	it("blames the smallest overlapping rect, not the page container", () => {
		const regions = buildRegions(clusters, [body, card], []);
		expect(regions.length).toBe(1);
		expect(regions[0].component).toBe("ColorCard");
		expect(regions[0].label).toBe("ColorCard");
		expect(regions[0].causal).toBe(false);
		expect(regions[0].box).toEqual({ x: 15, y: 15, w: 100, h: 50 });
	});

	it("marks causal when the component file matches a changed file", () => {
		const regions = buildRegions(clusters, [body, card], ["src/ColorCard.tsx"]);
		expect(regions[0].causal).toBe(true);
	});

	it("degrades to tag.class labels on non-React pages", () => {
		const plain: ComponentRect = { ...card, component: null, file: null };
		const regions = buildRegions(clusters, [body, plain], []);
		expect(regions[0].component).toBe(null);
		expect(regions[0].label).toBe("div.color-card");
	});

	it("labels unmatched clusters (unknown), never throws", () => {
		const far: Box[] = [{ x: 5000, y: 5000, w: 10, h: 10, pixels: 100 }];
		const regions = buildRegions(far, [card], []);
		expect(regions[0].label).toBe("(unknown)");
		expect(buildRegions(clusters, [], [])).toHaveLength(1);
	});
});

describe("parseComponentRects", () => {
	it("parses the page-walk JSON payload", () => {
		const payload = JSON.stringify([
			{
				tag: "div",
				className: "x",
				x: 1,
				y: 2,
				w: 3,
				h: 4,
				component: "Card",
				file: null,
			},
		]);
		expect(parseComponentRects(payload)).toEqual([
			{
				tag: "div",
				className: "x",
				rect: { x: 1, y: 2, w: 3, h: 4 },
				component: "Card",
				file: null,
			},
		]);
	});

	it("returns [] for garbage", () => {
		expect(parseComponentRects("not json")).toEqual([]);
		expect(parseComponentRects(42)).toEqual([]);
		expect(parseComponentRects('{"a":1}')).toEqual([]);
		expect(parseComponentRects('[{"x":"NaN"}]')).toEqual([]);
	});
});
