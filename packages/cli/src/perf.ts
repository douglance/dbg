// Plan X — perf flight recorder pure functions. No CDP/store deps: these are
// the testable core (batch parsing, delta math, budget checks) the daemon and
// CLI wire together. Kept side-effect-free so `dbg after` can compute a delta
// from pure store reads without extra round-trips.

export interface PerfSampleRow {
	ts: number;
	navId: number;
	captureId: number | null;
	metric: string;
	value: number;
	detail: string | null;
}

export interface PerfDelta {
	lcp: { anchor: number | null; after: number | null; delta: number | null };
	// after = sum of layout-shift in (anchorTs, afterTs]; anchor = sum ts<=anchorTs.
	cls: { anchor: number; after: number; delta: number };
	longtasks: { newCount: number };
	jsHeap: { anchor: number | null; after: number | null; delta: number | null };
	bundleBytes: {
		anchor: number | null;
		after: number | null;
		delta: number | null;
	};
	// metric='event' entries in the after window ("during flows").
	interactions: { count: number; maxDuration: number };
}

/**
 * Parse a `__dbg_perf__` binding batch (JSON array of normalized observer
 * entries `{type,name,ts,value}`) into perf_samples rows. captureId is null
 * (these are observer-sourced). Robust to malformed JSON (returns []) and
 * skips entries with a non-finite ts or value.
 */
export function parsePerfBatch(
	payload: string,
	navId: number,
): PerfSampleRow[] {
	let entries: unknown;
	try {
		entries = JSON.parse(payload);
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];
	const rows: PerfSampleRow[] = [];
	for (const raw of entries) {
		const entry = raw as {
			type?: unknown;
			name?: unknown;
			ts?: unknown;
			value?: unknown;
		};
		const type = typeof entry.type === "string" ? entry.type : "";
		const name = typeof entry.name === "string" ? entry.name : "";
		const ts = Number(entry.ts);
		const value = Number(entry.value);
		if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
		let metric: string;
		let detail: string | null = null;
		switch (type) {
			case "largest-contentful-paint":
				metric = "lcp";
				break;
			case "layout-shift":
				metric = "cls";
				break;
			case "longtask":
				metric = "longtask";
				break;
			case "paint":
				metric = name === "first-contentful-paint" ? "fcp" : "paint";
				break;
			case "event":
				metric = "event";
				detail = name;
				break;
			default:
				continue;
		}
		rows.push({ ts, navId, captureId: null, metric, value, detail });
	}
	return rows;
}

/**
 * Compute the before/after perf delta from the recorder's perf_samples rows.
 * Capture-keyed metrics (jsHeap, bundleBytes) read the row matching a capture
 * id; window metrics (cls, longtask, event) filter by ts; lcp takes the latest
 * value at/under each side's ts.
 */
export function computePerfDelta(
	samples: PerfSampleRow[],
	anchorCaptureId: number,
	afterCaptureId: number,
	anchorTs: number,
	afterTs: number,
): PerfDelta {
	const captureMetric = (captureId: number, metric: string): number | null => {
		for (const s of samples) {
			if (s.captureId === captureId && s.metric === metric) return s.value;
		}
		return null;
	};

	const jsHeapAnchor = captureMetric(anchorCaptureId, "JSHeapUsedSize");
	const jsHeapAfter = captureMetric(afterCaptureId, "JSHeapUsedSize");
	const jsHeapDelta =
		jsHeapAnchor != null && jsHeapAfter != null
			? jsHeapAfter - jsHeapAnchor
			: null;

	const bundleAnchor = captureMetric(anchorCaptureId, "bundle_bytes");
	const bundleAfter = captureMetric(afterCaptureId, "bundle_bytes");
	const bundleDelta =
		bundleAnchor != null && bundleAfter != null
			? bundleAfter - bundleAnchor
			: null;

	let clsAnchor = 0;
	let clsAfter = 0;
	let newLongtasks = 0;
	let interactionCount = 0;
	let maxInteraction = 0;
	let lcpAnchor: number | null = null;
	let lcpAnchorTs = Number.NEGATIVE_INFINITY;
	let lcpAfter: number | null = null;
	let lcpAfterTs = Number.NEGATIVE_INFINITY;
	for (const s of samples) {
		switch (s.metric) {
			case "cls":
				if (s.ts <= anchorTs) clsAnchor += s.value;
				if (s.ts > anchorTs && s.ts <= afterTs) clsAfter += s.value;
				break;
			case "longtask":
				if (s.ts > anchorTs && s.ts <= afterTs) newLongtasks += 1;
				break;
			case "event":
				if (s.ts > anchorTs && s.ts <= afterTs) {
					interactionCount += 1;
					if (s.value > maxInteraction) maxInteraction = s.value;
				}
				break;
			case "lcp":
				if (s.ts <= anchorTs && s.ts >= lcpAnchorTs) {
					lcpAnchorTs = s.ts;
					lcpAnchor = s.value;
				}
				if (s.ts <= afterTs && s.ts >= lcpAfterTs) {
					lcpAfterTs = s.ts;
					lcpAfter = s.value;
				}
				break;
		}
	}
	const lcpDelta =
		lcpAnchor != null && lcpAfter != null ? lcpAfter - lcpAnchor : null;

	return {
		lcp: { anchor: lcpAnchor, after: lcpAfter, delta: lcpDelta },
		cls: { anchor: clsAnchor, after: clsAfter, delta: clsAfter },
		longtasks: { newCount: newLongtasks },
		jsHeap: { anchor: jsHeapAnchor, after: jsHeapAfter, delta: jsHeapDelta },
		bundleBytes: {
			anchor: bundleAnchor,
			after: bundleAfter,
			delta: bundleDelta,
		},
		interactions: { count: interactionCount, maxDuration: maxInteraction },
	};
}

/** Parse a budget spec like "lcp=2500,cls=0.1" → {lcp:2500,cls:0.1}. Ignores
 * malformed pairs (missing key/value, non-numeric value). */
export function parsePerfBudget(spec: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const pair of spec.split(",")) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const key = pair.slice(0, eq).trim();
		const rawValue = pair.slice(eq + 1).trim();
		if (key.length === 0 || rawValue.length === 0) continue;
		const value = Number(rawValue);
		if (!Number.isFinite(value)) continue;
		out[key] = value;
	}
	return out;
}

/** Return one breach line per budget the delta exceeds (empty = within budget).
 * Budget keys: lcp, cls, longtask, jsheap, bundle — all checked against the
 * "after" side of the delta. */
export function checkPerfBudget(
	delta: PerfDelta,
	budget: Record<string, number>,
): string[] {
	const breaches: string[] = [];
	if (
		budget.lcp !== undefined &&
		delta.lcp.after != null &&
		delta.lcp.after > budget.lcp
	) {
		breaches.push(
			`lcp ${Math.round(delta.lcp.after)}ms > budget ${budget.lcp}ms`,
		);
	}
	if (budget.cls !== undefined && delta.cls.after > budget.cls) {
		breaches.push(`cls ${delta.cls.after.toFixed(3)} > budget ${budget.cls}`);
	}
	if (
		budget.longtask !== undefined &&
		delta.longtasks.newCount > budget.longtask
	) {
		breaches.push(
			`longtask ${delta.longtasks.newCount} > budget ${budget.longtask}`,
		);
	}
	if (
		budget.jsheap !== undefined &&
		delta.jsHeap.after != null &&
		delta.jsHeap.after > budget.jsheap
	) {
		breaches.push(
			`jsheap ${Math.round(delta.jsHeap.after)} > budget ${budget.jsheap}`,
		);
	}
	if (
		budget.bundle !== undefined &&
		delta.bundleBytes.after != null &&
		delta.bundleBytes.after > budget.bundle
	) {
		breaches.push(
			`bundle ${Math.round(delta.bundleBytes.after)} > budget ${budget.bundle}`,
		);
	}
	return breaches;
}
