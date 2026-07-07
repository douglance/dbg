import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Axis-aligned rectangle in pixel coordinates. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A cluster of changed pixels: bounding box plus the changed-pixel count inside it. */
export interface Box extends Rect {
	pixels: number;
}

export interface DiffPngsOptions {
	/** pixelmatch color-distance threshold (0..1). Default 0.1. */
	threshold?: number;
	/** Merge clusters whose bounding boxes are closer than this many pixels. Default 8. */
	clusterMergeDistance?: number;
	/** Drop clusters smaller than this in either dimension. Default 4 (i.e. < 4x4). */
	minClusterSize?: number;
}

export interface DiffPngsResult {
	diffPixels: number;
	totalPixels: number;
	/** diffPixels / totalPixels * 100 */
	diffPercent: number;
	/** Width of the (max-canvas) compared area. */
	width: number;
	/** Height of the (max-canvas) compared area. */
	height: number;
	/** True when the two inputs had different dimensions. */
	dimensionsChanged: boolean;
	/** Encoded visual diff PNG (changed pixels highlighted over a faded grayscale base). */
	diffPng: Buffer;
	/** Changed-pixel clusters, largest first. */
	clusters: Box[];
}

/** Pad an image onto a white canvas of the given size (no-op when already that size). */
function padToCanvas(src: PNG, width: number, height: number): PNG {
	if (src.width === width && src.height === height) {
		return src;
	}
	const out = new PNG({ width, height });
	// Opaque white background (RGBA all 255).
	out.data.fill(255);
	PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
	return out;
}

function rectGap(a: Rect, b: Rect): { gapX: number; gapY: number } {
	const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
	const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
	return { gapX, gapY };
}

/** Union boxes that are closer than `distance` px (in both axes) until stable. */
function mergeBoxes(boxes: Box[], distance: number): Box[] {
	const out = boxes.slice();
	let merged = true;
	while (merged) {
		merged = false;
		outer: for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				const a = out[i];
				const b = out[j];
				const { gapX, gapY } = rectGap(a, b);
				if (gapX < distance && gapY < distance) {
					const x = Math.min(a.x, b.x);
					const y = Math.min(a.y, b.y);
					out[i] = {
						x,
						y,
						w: Math.max(a.x + a.w, b.x + b.w) - x,
						h: Math.max(a.y + a.h, b.y + b.h) - y,
						pixels: a.pixels + b.pixels,
					};
					out.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}
	return out;
}

/**
 * Flood-fill changed pixels (8-connected) in a pixelmatch diff-mask into bounding
 * boxes, merge near-adjacent boxes, and drop boxes below the minimum size.
 * A pixel counts as changed when its alpha channel is non-zero in the mask.
 */
function extractClusters(
	mask: Uint8Array,
	width: number,
	height: number,
	mergeDistance: number,
	minSize: number,
): Box[] {
	const visited = new Uint8Array(width * height);
	const raw: Box[] = [];
	const stack: number[] = [];
	for (let start = 0; start < width * height; start++) {
		if (visited[start] || mask[start * 4 + 3] === 0) {
			continue;
		}
		visited[start] = 1;
		stack.push(start);
		let minX = width;
		let minY = height;
		let maxX = 0;
		let maxY = 0;
		let pixels = 0;
		while (stack.length > 0) {
			const idx = stack.pop();
			if (idx === undefined) {
				break;
			}
			const x = idx % width;
			const y = (idx - x) / width;
			pixels++;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					const nIdx = ny * width + nx;
					if (visited[nIdx] || mask[nIdx * 4 + 3] === 0) continue;
					visited[nIdx] = 1;
					stack.push(nIdx);
				}
			}
		}
		raw.push({
			x: minX,
			y: minY,
			w: maxX - minX + 1,
			h: maxY - minY + 1,
			pixels,
		});
	}
	const boxes = mergeBoxes(raw, mergeDistance).filter(
		(b) => b.w >= minSize && b.h >= minSize,
	);
	boxes.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
	return boxes;
}

/**
 * Pixel-diff two encoded PNGs. Different-size inputs are composited onto a white
 * canvas of the max dimensions (and flagged via `dimensionsChanged`).
 */
export function diffPngs(
	aBuf: Buffer,
	bBuf: Buffer,
	opts: DiffPngsOptions = {},
): DiffPngsResult {
	const threshold = opts.threshold ?? 0.1;
	const mergeDistance = opts.clusterMergeDistance ?? 8;
	const minClusterSize = opts.minClusterSize ?? 4;

	const aRaw = PNG.sync.read(aBuf);
	const bRaw = PNG.sync.read(bBuf);
	const dimensionsChanged =
		aRaw.width !== bRaw.width || aRaw.height !== bRaw.height;
	const width = Math.max(aRaw.width, bRaw.width);
	const height = Math.max(aRaw.height, bRaw.height);
	const a = padToCanvas(aRaw, width, height);
	const b = padToCanvas(bRaw, width, height);

	// Visual diff (grayscale-faded base with changed pixels highlighted).
	const diff = new PNG({ width, height });
	const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
		threshold,
	});
	// Mask-only pass for clustering: only counted diff pixels are drawn (alpha > 0).
	const mask = new PNG({ width, height });
	pixelmatch(a.data, b.data, mask.data, width, height, {
		threshold,
		diffMask: true,
	});

	const clusters = extractClusters(
		mask.data,
		width,
		height,
		mergeDistance,
		minClusterSize,
	);
	const totalPixels = width * height;
	return {
		diffPixels,
		totalPixels,
		diffPercent: totalPixels === 0 ? 0 : (diffPixels / totalPixels) * 100,
		width,
		height,
		dimensionsChanged,
		diffPng: PNG.sync.write(diff),
		clusters,
	};
}

/** A candidate rectangle (e.g. a component layout rect) carrying arbitrary metadata. */
export interface HitRect<T> {
	box: Rect;
	meta: T;
}

/** Per-cluster hit-test outcome: the max-overlap rect's meta, or null when nothing overlaps. */
export interface HitResult<T> {
	cluster: Box;
	meta: T | null;
	overlapArea: number;
}

function intersectionArea(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

/**
 * For each cluster, pick the rect with the largest intersection area.
 * Clusters that overlap nothing get `meta: null`. Result order matches `clusters`.
 */
export function hitTest<T>(
	clusters: Box[],
	rects: Array<HitRect<T>>,
): Array<HitResult<T>> {
	return clusters.map((cluster) => {
		let best: T | null = null;
		let bestArea = 0;
		for (const rect of rects) {
			const area = intersectionArea(cluster, rect.box);
			if (area > bestArea) {
				bestArea = area;
				best = rect.meta;
			}
		}
		return { cluster, meta: best, overlapArea: bestArea };
	});
}
