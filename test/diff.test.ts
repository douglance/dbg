import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { type Box, diffPngs, hitTest } from "../packages/diff/src/index.js";

function makePng(
	width: number,
	height: number,
	paint?: (png: PNG) => void,
): Buffer {
	const png = new PNG({ width, height });
	png.data.fill(255); // opaque white
	if (paint) paint(png);
	return PNG.sync.write(png);
}

function fillRect(
	png: PNG,
	x: number,
	y: number,
	w: number,
	h: number,
	rgb: [number, number, number],
): void {
	for (let yy = y; yy < y + h; yy++) {
		for (let xx = x; xx < x + w; xx++) {
			const i = (yy * png.width + xx) * 4;
			png.data[i] = rgb[0];
			png.data[i + 1] = rgb[1];
			png.data[i + 2] = rgb[2];
			png.data[i + 3] = 255;
		}
	}
}

describe("diffPngs", () => {
	it("measures a known changed block and clusters it", () => {
		const before = makePng(100, 100);
		const after = makePng(100, 100, (p) =>
			fillRect(p, 10, 10, 20, 20, [0, 0, 0]),
		);
		const r = diffPngs(before, after);

		expect(r.dimensionsChanged).toBe(false);
		expect(r.width).toBe(100);
		expect(r.height).toBe(100);
		expect(r.totalPixels).toBe(10000);
		// 20x20 block = 400 px = 4%; allow AA-detection tolerance at the edges
		expect(r.diffPercent).toBeGreaterThan(3.4);
		expect(r.diffPercent).toBeLessThan(4.6);
		expect(r.diffPixels).toBe(Math.round((r.diffPercent / 100) * 10000));

		expect(r.clusters.length).toBe(1);
		const c = r.clusters[0];
		expect(Math.abs(c.x - 10)).toBeLessThanOrEqual(2);
		expect(Math.abs(c.y - 10)).toBeLessThanOrEqual(2);
		expect(Math.abs(c.w - 20)).toBeLessThanOrEqual(4);
		expect(Math.abs(c.h - 20)).toBeLessThanOrEqual(4);
		expect(c.pixels).toBeGreaterThan(300);

		// diff PNG decodes and matches the compared canvas
		const decoded = PNG.sync.read(r.diffPng);
		expect(decoded.width).toBe(100);
		expect(decoded.height).toBe(100);
	});

	it("reports zero diff for identical images", () => {
		const a = makePng(50, 50, (p) => fillRect(p, 5, 5, 10, 10, [30, 90, 200]));
		const r = diffPngs(a, a);
		expect(r.diffPixels).toBe(0);
		expect(r.diffPercent).toBe(0);
		expect(r.clusters).toEqual([]);
		expect(r.dimensionsChanged).toBe(false);
	});

	it("pads different-dimension inputs onto a white max-canvas without crashing", () => {
		const a = makePng(100, 100);
		const b = makePng(120, 80, (p) =>
			fillRect(p, 0, 0, 120, 80, [20, 40, 200]),
		);
		const r = diffPngs(a, b);

		expect(r.dimensionsChanged).toBe(true);
		expect(r.width).toBe(120);
		expect(r.height).toBe(100);
		expect(r.totalPixels).toBe(12000);
		expect(r.diffPixels).toBeGreaterThan(0);

		const decoded = PNG.sync.read(r.diffPng);
		expect(decoded.width).toBe(120);
		expect(decoded.height).toBe(100);
	});

	it("merges clusters closer than the merge distance", () => {
		const before = makePng(100, 100);
		// two 10x10 blocks separated by a 6px gap (< 8) -> one merged cluster
		const after = makePng(100, 100, (p) => {
			fillRect(p, 10, 10, 10, 10, [200, 0, 0]);
			fillRect(p, 10, 26, 10, 10, [200, 0, 0]);
		});
		const r = diffPngs(before, after);
		expect(r.clusters.length).toBe(1);
		const c = r.clusters[0];
		expect(c.y).toBeLessThanOrEqual(11);
		expect(c.y + c.h).toBeGreaterThanOrEqual(35);
		expect(c.pixels).toBeGreaterThan(150);
	});

	it("keeps clusters farther than the merge distance separate", () => {
		const before = makePng(100, 100);
		// 30px gap between blocks -> two clusters
		const after = makePng(100, 100, (p) => {
			fillRect(p, 10, 10, 10, 10, [200, 0, 0]);
			fillRect(p, 10, 50, 10, 10, [200, 0, 0]);
		});
		const r = diffPngs(before, after);
		expect(r.clusters.length).toBe(2);
	});

	it("drops clusters smaller than the minimum size", () => {
		const before = makePng(100, 100);
		const after = makePng(100, 100, (p) =>
			fillRect(p, 50, 50, 3, 3, [200, 0, 0]),
		);
		const r = diffPngs(before, after);
		expect(r.diffPixels).toBeGreaterThan(0);
		expect(r.clusters).toEqual([]);
	});
});

describe("hitTest", () => {
	it("picks the max-intersection-area rect per cluster", () => {
		const clusters: Box[] = [
			{ x: 10, y: 10, w: 20, h: 20, pixels: 400 },
			{ x: 200, y: 200, w: 5, h: 5, pixels: 25 },
		];
		const rects = [
			{ box: { x: 0, y: 0, w: 15, h: 15 }, meta: "small" },
			{ box: { x: 12, y: 12, w: 30, h: 30 }, meta: "big" },
		];
		const hits = hitTest(clusters, rects);

		expect(hits.length).toBe(2);
		expect(hits[0].cluster).toBe(clusters[0]);
		expect(hits[0].meta).toBe("big"); // 18*18=324 beats 5*5=25
		expect(hits[0].overlapArea).toBe(18 * 18);
		expect(hits[1].meta).toBeNull(); // no rect overlaps the second cluster
		expect(hits[1].overlapArea).toBe(0);
	});

	it("returns empty for no clusters and nulls for no rects", () => {
		expect(hitTest([], [{ box: { x: 0, y: 0, w: 1, h: 1 }, meta: 1 }])).toEqual(
			[],
		);
		const clusters: Box[] = [{ x: 0, y: 0, w: 10, h: 10, pixels: 100 }];
		const hits = hitTest(clusters, []);
		expect(hits[0].meta).toBeNull();
	});
});
