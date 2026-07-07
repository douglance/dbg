// DOM/style/component snapshot (visual flight recorder, Phase 4).
//
// Two independent collections per capture:
// - `elements`: DOMSnapshot.captureSnapshot layout nodes with a whitelisted
//   computed-style map and a stable nth-of-type path (style diff input).
// - `components`: viewport rects from an in-page walk that resolves each
//   element's nearest named React component via its __reactFiber$ expando
//   (blame input; non-React pages simply get null components — never throws).

import { type Box, type HitRect, hitTest } from "@dbg/diff";

export const STYLE_WHITELIST = [
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"margin-top",
	"margin-bottom",
	"color",
	"background-color",
	"font-size",
	"font-weight",
	"display",
	"position",
	"border-radius",
	"opacity",
	"visibility",
	"flex-direction",
	"gap",
	"width",
	"height",
];

export interface SnapshotRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface SnapshotElement {
	/** Stable nth-of-type path from the root element, e.g. "html>body>div:nth-of-type(2)". */
	path: string;
	tag: string;
	className: string;
	rect: SnapshotRect;
	styles: Record<string, string>;
}

export interface ComponentRect {
	tag: string;
	className: string;
	rect: SnapshotRect;
	component: string | null;
	file: string | null;
}

export interface PageSnapshot {
	ts: number;
	elements: SnapshotElement[];
	components: ComponentRect[];
}

export interface SnapshotStyleChange {
	selector: string;
	prop: string;
	before: string;
	after: string;
}

export interface BlameRegion {
	box: SnapshotRect;
	label: string;
	component: string | null;
	file: string | null;
	causal: boolean;
}

// ─── DOMSnapshot.captureSnapshot parsing ───

interface RawDocument {
	nodes?: {
		parentIndex?: number[];
		nodeType?: number[];
		nodeName?: number[];
		attributes?: number[][];
	};
	layout?: {
		nodeIndex?: number[];
		styles?: number[][];
		bounds?: number[][];
	};
}

export interface RawDomSnapshot {
	documents?: RawDocument[];
	strings?: string[];
}

/** Flatten a DOMSnapshot.captureSnapshot result into per-element records.
 * Total: malformed input yields []. */
export function parseDomSnapshot(
	raw: RawDomSnapshot,
	whitelist: string[] = STYLE_WHITELIST,
): SnapshotElement[] {
	const doc = raw.documents?.[0];
	const strings = raw.strings ?? [];
	if (!doc?.nodes || !doc.layout) return [];
	const parentIndex = doc.nodes.parentIndex ?? [];
	const nodeType = doc.nodes.nodeType ?? [];
	const nodeName = doc.nodes.nodeName ?? [];
	const attributes = doc.nodes.attributes ?? [];
	const nodeIndex = doc.layout.nodeIndex ?? [];
	const layoutStyles = doc.layout.styles ?? [];
	const bounds = doc.layout.bounds ?? [];

	const str = (i: number | undefined): string =>
		i !== undefined && i >= 0 && i < strings.length ? strings[i] : "";
	const tagOf = (n: number): string => str(nodeName[n]).toLowerCase();

	const nthCache = new Map<number, number>();
	const nthOf = (n: number): number => {
		const cached = nthCache.get(n);
		if (cached !== undefined) return cached;
		const parent = parentIndex[n];
		const tag = tagOf(n);
		let nth = 1;
		for (let i = 0; i < n; i++) {
			if (parentIndex[i] === parent && nodeType[i] === 1 && tagOf(i) === tag) {
				nth++;
			}
		}
		nthCache.set(n, nth);
		return nth;
	};

	const pathCache = new Map<number, string>();
	const pathOf = (n: number): string => {
		const cached = pathCache.get(n);
		if (cached !== undefined) return cached;
		const segment = `${tagOf(n)}:nth-of-type(${nthOf(n)})`;
		const parent = parentIndex[n];
		const isRoot = parent === undefined || parent < 0 || nodeType[parent] !== 1;
		const path = isRoot ? segment : `${pathOf(parent)}>${segment}`;
		pathCache.set(n, path);
		return path;
	};

	const classOf = (n: number): string => {
		const attrs = attributes[n] ?? [];
		for (let i = 0; i + 1 < attrs.length; i += 2) {
			if (str(attrs[i]) === "class") return str(attrs[i + 1]);
		}
		return "";
	};

	const out: SnapshotElement[] = [];
	for (let li = 0; li < nodeIndex.length; li++) {
		const n = nodeIndex[li];
		if (nodeType[n] !== 1) continue; // element nodes only
		const b = bounds[li] ?? [];
		const rect = { x: b[0] ?? 0, y: b[1] ?? 0, w: b[2] ?? 0, h: b[3] ?? 0 };
		if (rect.w <= 0 || rect.h <= 0) continue;
		const styleIdxs = layoutStyles[li] ?? [];
		const styles: Record<string, string> = {};
		for (let si = 0; si < whitelist.length; si++) {
			const value = str(styleIdxs[si]);
			if (value) styles[whitelist[si]] = value;
		}
		out.push({
			path: pathOf(n),
			tag: tagOf(n),
			className: classOf(n),
			rect,
			styles,
		});
	}
	return out;
}

// ─── Style diff ───

function selectorFor(el: SnapshotElement): string {
	const firstClass = el.className.trim().split(/\s+/)[0];
	return firstClass ? `${el.tag}.${firstClass}` : el.path;
}

/** Structural style diff: match elements by path, compare whitelisted
 * computed styles, biggest-element-first, capped. */
export function diffSnapshots(
	before: SnapshotElement[],
	after: SnapshotElement[],
	cap = 50,
): SnapshotStyleChange[] {
	const beforeByPath = new Map(before.map((e) => [e.path, e]));
	const changes: Array<SnapshotStyleChange & { area: number }> = [];
	for (const a of after) {
		const b = beforeByPath.get(a.path);
		if (!b) continue;
		const props = new Set([...Object.keys(b.styles), ...Object.keys(a.styles)]);
		for (const prop of props) {
			const beforeVal = b.styles[prop] ?? "";
			const afterVal = a.styles[prop] ?? "";
			if (beforeVal !== afterVal) {
				changes.push({
					selector: selectorFor(a),
					prop,
					before: beforeVal,
					after: afterVal,
					area: a.rect.w * a.rect.h,
				});
			}
		}
	}
	changes.sort((x, y) => y.area - x.area);
	return changes.slice(0, cap).map(({ area: _area, ...rest }) => rest);
}

// ─── Blame regions ───

function basename(p: string): string {
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

function tagLabel(c: ComponentRect): string {
	const firstClass = c.className.trim().split(/\s+/)[0];
	return firstClass ? `${c.tag}.${firstClass}` : c.tag;
}

/** Hit-test diff clusters against component rects (smallest rect wins ties,
 * so specific elements beat page-level containers). `causal` marks regions
 * whose component file matches a changed/HMR'd file since the baseline. */
export function buildRegions(
	clusters: Box[],
	components: ComponentRect[],
	changedFiles: string[],
	dpr = 1,
): BlameRegion[] {
	const candidates: Array<HitRect<ComponentRect>> = components
		.filter((c) => c.rect.w > 0 && c.rect.h > 0)
		.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)
		.map((c) => ({
			box: {
				x: c.rect.x * dpr,
				y: c.rect.y * dpr,
				w: c.rect.w * dpr,
				h: c.rect.h * dpr,
			},
			meta: c,
		}));
	const changedBasenames = new Set(changedFiles.map(basename));
	return hitTest(clusters, candidates).map(({ cluster, meta }) => {
		const component = meta?.component ?? null;
		const file = meta?.file ?? null;
		return {
			box: { x: cluster.x, y: cluster.y, w: cluster.w, h: cluster.h },
			label: component ?? (meta ? tagLabel(meta) : "(unknown)"),
			component,
			file,
			causal: file !== null && changedBasenames.has(basename(file)),
		};
	});
}

// ─── In-page component walk + CDP capture ───

// Runs in the page: sample visible elements, resolve each one's nearest named
// React component by walking its fiber (dev builds; prod/non-React → nulls).
// _debugSource exists only in React <19 dev — degrade to null, never fail.
export const COMPONENT_WALK_SOURCE = `(() => {
	const out = [];
	const els = document.querySelectorAll("body, body *");
	const limit = Math.min(els.length, 1500);
	for (let i = 0; i < limit; i++) {
		const el = els[i];
		let rect;
		try { rect = el.getBoundingClientRect(); } catch (_e) { continue; }
		if (rect.width <= 0 || rect.height <= 0) continue;
		let component = null;
		let file = null;
		try {
			const keys = Object.keys(el);
			let fiberKey = null;
			for (let k = 0; k < keys.length; k++) {
				if (keys[k].indexOf("__reactFiber$") === 0) { fiberKey = keys[k]; break; }
			}
			if (fiberKey) {
				let fiber = el[fiberKey];
				let hops = 0;
				while (fiber && hops < 50) {
					const t = fiber.type;
					const name = typeof t === "function"
						? (t.displayName || t.name)
						: (t && typeof t === "object" ? t.displayName : null);
					if (name) {
						component = name;
						const src = fiber._debugSource;
						if (src && typeof src.fileName === "string") file = src.fileName;
						break;
					}
					fiber = fiber._debugOwner || fiber.return;
					hops++;
				}
			}
		} catch (_e) { /* fiber internals are best-effort */ }
		out.push({
			tag: el.tagName.toLowerCase(),
			className: typeof el.className === "string" ? el.className : "",
			x: rect.x, y: rect.y, w: rect.width, h: rect.height,
			component, file,
		});
	}
	return JSON.stringify(out);
})()`;

/** Parse the page-walk result (a JSON string). Total: garbage → []. */
export function parseComponentRects(value: unknown): ComponentRect[] {
	let arr: unknown;
	try {
		arr = typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const out: ComponentRect[] = [];
	for (const item of arr) {
		if (typeof item !== "object" || item === null) continue;
		const e = item as Record<string, unknown>;
		const x = Number(e.x);
		const y = Number(e.y);
		const w = Number(e.w);
		const h = Number(e.h);
		if (![x, y, w, h].every(Number.isFinite)) continue;
		out.push({
			tag: typeof e.tag === "string" ? e.tag : "",
			className: typeof e.className === "string" ? e.className : "",
			rect: { x, y, w, h },
			component: typeof e.component === "string" ? e.component : null,
			file: typeof e.file === "string" ? e.file : null,
		});
	}
	return out;
}

export interface CdpSender {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Capture the page's DOM/style/component snapshot. Never throws; each
 * collection independently degrades to []. */
export async function capturePageSnapshot(
	cdp: CdpSender,
	whitelist: string[] = STYLE_WHITELIST,
): Promise<PageSnapshot> {
	let elements: SnapshotElement[] = [];
	let components: ComponentRect[] = [];
	try {
		const raw = (await cdp.send("DOMSnapshot.captureSnapshot", {
			computedStyles: whitelist,
			includeDOMRects: true,
		})) as RawDomSnapshot;
		elements = parseDomSnapshot(raw, whitelist);
	} catch {
		// DOMSnapshot unsupported or mid-navigation
	}
	try {
		const result = (await cdp.send("Runtime.evaluate", {
			expression: COMPONENT_WALK_SOURCE,
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		components = parseComponentRects(result.result?.value);
	} catch {
		// evaluate can fail mid-navigation
	}
	return { ts: Date.now(), elements, components };
}
