// Anchor resolution for `dbg after` (visual flight recorder, Phase 3).
//
// Pure functions over capture/epoch rows: parse an `--at` spec and pick the
// "before" capture to diff against. The daemon supplies rows ordered by id
// ascending; these functions never touch the store or the page.

export interface AnchorCaptureRow {
	id: number;
	ts: number;
	url: string;
	scrollY: number;
	pngPath: string;
	/** Parsed changed_files JSON column. */
	changedFiles: string[];
	/** Gzipped DOM/style/component snapshot on disk (Phase 4), if captured. */
	snapshotPath?: string | null;
}

export interface AnchorEpochRow {
	id: number;
	ts: number;
	name: string | null;
}

export type AnchorSpec =
	| { kind: "capture"; id: number }
	| { kind: "mark"; name: string }
	| { kind: "time"; ts: number }
	| { kind: "file"; path: string }
	| { kind: "default" };

const RELATIVE_UNITS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Parse an `--at` value. `now` is injectable for tests (used by relative
 * times like "10m" = ten minutes ago). Returns an error string for
 * unusable specs. */
export function parseAnchorSpec(
	at?: string,
	now: number = Date.now(),
): AnchorSpec | { error: string } {
	if (at === undefined || at.trim() === "") return { kind: "default" };
	const idx = at.indexOf(":");
	if (idx < 1) {
		return {
			error: `invalid --at "${at}" (expected capture:<id>, mark:<name>, time:<ts>, or file:<path>)`,
		};
	}
	const kind = at.slice(0, idx);
	const value = at.slice(idx + 1);
	switch (kind) {
		case "capture": {
			const id = Number.parseInt(value, 10);
			if (!Number.isFinite(id) || String(id) !== value.trim()) {
				return { error: `invalid capture id "${value}"` };
			}
			return { kind: "capture", id };
		}
		case "mark": {
			if (value === "") return { error: "empty mark name" };
			return { kind: "mark", name: value };
		}
		case "time": {
			// Relative ("10m" = 10 minutes ago), epoch ms, or ISO date.
			const relative = /^(\d+)([smhd])$/.exec(value.trim());
			if (relative) {
				const amount = Number.parseInt(relative[1], 10);
				return {
					kind: "time",
					ts: now - amount * RELATIVE_UNITS[relative[2]],
				};
			}
			const asNumber = Number(value);
			const ts = Number.isFinite(asNumber) ? asNumber : Date.parse(value);
			if (!Number.isFinite(ts)) {
				return {
					error: `invalid time "${value}" (relative like 10m, epoch ms, or ISO date)`,
				};
			}
			return { kind: "time", ts };
		}
		case "file": {
			if (value === "") return { error: "empty file path" };
			return { kind: "file", path: value };
		}
		default:
			return {
				error: `unknown anchor kind "${kind}" (expected capture, mark, time, or file)`,
			};
	}
}

function lastAtOrBefore(
	captures: AnchorCaptureRow[],
	ts: number,
): AnchorCaptureRow | null {
	let found: AnchorCaptureRow | null = null;
	for (const c of captures) {
		if (c.ts <= ts) found = c;
		else break;
	}
	return found ?? captures[0] ?? null;
}

/**
 * Pick the anchor ("before") capture. `captures` and `epochs` must be
 * ascending by id. Semantics:
 * - capture:<id>  — that exact capture
 * - mark:<name>   — last capture at/before the latest epoch with that name
 * - time:<ts>     — last capture at/before ts
 * - file:<path>   — the capture just before the first capture whose
 *                   changed_files contains path (the pre-save state)
 * - default       — last capture at/before the latest epoch; with no epochs,
 *                   the first capture of the recording
 */
export function resolveAnchor(
	spec: AnchorSpec,
	captures: AnchorCaptureRow[],
	epochs: AnchorEpochRow[],
): AnchorCaptureRow | null {
	if (captures.length === 0) return null;
	switch (spec.kind) {
		case "capture":
			return captures.find((c) => c.id === spec.id) ?? null;
		case "mark": {
			const epoch = [...epochs].reverse().find((e) => e.name === spec.name);
			if (!epoch) return null;
			return lastAtOrBefore(captures, epoch.ts);
		}
		case "time":
			return lastAtOrBefore(captures, spec.ts);
		case "file": {
			const index = captures.findIndex((c) =>
				c.changedFiles.includes(spec.path),
			);
			if (index === -1) return null;
			return captures[index - 1] ?? captures[index];
		}
		case "default": {
			const epoch = epochs[epochs.length - 1];
			if (epoch) return lastAtOrBefore(captures, epoch.ts);
			return captures[0];
		}
	}
}
