// Network diff for `dbg after`: group requests in the anchor window vs the
// after window by method + normalized URL pattern, then classify each group as
// added / removed / status-changed / duration-delta. Pure + deterministic so
// it is unit-testable in isolation from CDP.

export interface NetRequest {
	method: string;
	url: string;
	status: number;
	/** Round-trip duration in ms (0 when unknown). */
	duration: number;
	type?: string;
}

export interface NetEntry {
	method: string;
	pattern: string;
	url: string;
	status: number;
	durationMs: number;
}

export interface NetStatusChange {
	method: string;
	pattern: string;
	url: string;
	before: number;
	after: number;
}

export interface NetDurationDelta {
	method: string;
	pattern: string;
	url: string;
	beforeMs: number;
	afterMs: number;
	deltaMs: number;
}

export interface NetworkDiff {
	added: NetEntry[];
	removed: NetEntry[];
	statusChanged: NetStatusChange[];
	durationDelta: NetDurationDelta[];
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

/** Collapse volatile path segments (numeric ids, uuids, long hashes) to `:id`
 * and drop the query string, so `/api/users/42?t=1` and `/api/users/99?t=2`
 * share one group. Host + normalized path form the pattern. */
export function normalizeUrlPattern(url: string): string {
	let host = "";
	let pathname = url;
	try {
		const parsed = new URL(url);
		host = parsed.host;
		pathname = parsed.pathname;
	} catch {
		// Not an absolute URL — treat the whole thing (sans query) as the path.
		pathname = url.split("?")[0];
	}
	const segments = pathname.split("/").map((seg) => {
		if (seg === "") return seg;
		if (/^\d+$/.test(seg) || UUID_RE.test(seg) || LONG_HEX_RE.test(seg)) {
			return ":id";
		}
		return seg;
	});
	return `${host}${segments.join("/")}`;
}

// Duration is "meaningfully different" when it moves by >50ms AND >25%.
const DURATION_ABS_MS = 50;
const DURATION_REL = 0.25;

function groupKey(req: NetRequest): string {
	return `${req.method.toUpperCase()} ${normalizeUrlPattern(req.url)}`;
}

/** Last request wins per group (the most representative recent sample). */
function groupBy(requests: NetRequest[]): Map<string, NetRequest> {
	const map = new Map<string, NetRequest>();
	for (const req of requests) map.set(groupKey(req), req);
	return map;
}

function toEntry(key: string, req: NetRequest): NetEntry {
	const pattern = key.slice(key.indexOf(" ") + 1);
	return {
		method: req.method.toUpperCase(),
		pattern,
		url: req.url,
		status: req.status,
		durationMs: req.duration,
	};
}

export function diffNetwork(
	before: NetRequest[],
	after: NetRequest[],
): NetworkDiff {
	const beforeGroups = groupBy(before);
	const afterGroups = groupBy(after);

	const added: NetEntry[] = [];
	const removed: NetEntry[] = [];
	const statusChanged: NetStatusChange[] = [];
	const durationDelta: NetDurationDelta[] = [];

	for (const [key, req] of afterGroups) {
		if (!beforeGroups.has(key)) added.push(toEntry(key, req));
	}
	for (const [key, req] of beforeGroups) {
		if (!afterGroups.has(key)) removed.push(toEntry(key, req));
	}
	for (const [key, afterReq] of afterGroups) {
		const beforeReq = beforeGroups.get(key);
		if (!beforeReq) continue;
		const pattern = key.slice(key.indexOf(" ") + 1);
		const method = afterReq.method.toUpperCase();
		if (beforeReq.status !== afterReq.status) {
			statusChanged.push({
				method,
				pattern,
				url: afterReq.url,
				before: beforeReq.status,
				after: afterReq.status,
			});
		}
		const delta = afterReq.duration - beforeReq.duration;
		const base = Math.max(beforeReq.duration, 1);
		if (
			Math.abs(delta) >= DURATION_ABS_MS &&
			Math.abs(delta) / base >= DURATION_REL
		) {
			durationDelta.push({
				method,
				pattern,
				url: afterReq.url,
				beforeMs: beforeReq.duration,
				afterMs: afterReq.duration,
				deltaMs: delta,
			});
		}
	}

	return { added, removed, statusChanged, durationDelta };
}
