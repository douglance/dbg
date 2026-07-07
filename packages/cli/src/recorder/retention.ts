// Bounded-history retention for the visual flight recorder.
//
// Design principle: history is metadata (cheap, keep it); pixels decay
// (expensive, bounded). Capture rows are never deleted — their blobs decay
// through tiers: 'full' PNG → 'thumb' (≤320px nearest-neighbor downscale) →
// 'meta' (blob deleted, annotations remain).
//
// Never decayed below full: the most recent capture, epoch anchors (nearest
// capture at-or-before each epoch ts), and any capture referenced by a
// `diffs` row. Within each epoch, first + last captures decay after the
// intermediates (keyframe compaction).

import * as fs from "node:fs";
import * as path from "node:path";
import { downscalePng } from "@dbg/diff";

export const DEFAULT_MAX_FULL_FRAMES = 200;
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100MB
export const DEFAULT_EVENTS_TTL_MS = 30 * 60 * 1000; // 30min
export const THUMB_MAX_WIDTH = 320;

export interface RetentionConfig {
	maxFullFrames: number;
	maxBytes: number;
}

/** The slice of EventStore that retention needs (query + write). */
export interface RetentionStore {
	query(sql: string, params?: unknown[]): Record<string, unknown>[];
	run(sql: string, params?: unknown[]): number;
}

interface CaptureRow {
	id: number;
	ts: number;
	epochId: number | null;
	tier: string;
	pngPath: string;
	snapshotPath: string | null;
	hash: string;
}

export interface RetentionResult {
	decayedToThumb: number[];
	decayedToMeta: number[];
	deletedBlobs: string[];
}

function captureRows(store: RetentionStore, sessionName: string): CaptureRow[] {
	return store
		.query(
			`SELECT id, ts, epoch_id, tier, png_path, snapshot_path, hash
			 FROM captures WHERE session_id = ? ORDER BY id`,
			[sessionName],
		)
		.map((row) => ({
			id: Number(row.id),
			ts: Number(row.ts),
			epochId: row.epoch_id == null ? null : Number(row.epoch_id),
			tier: String(row.tier ?? "full"),
			pngPath: String(row.png_path ?? ""),
			snapshotPath:
				row.snapshot_path == null ? null : String(row.snapshot_path),
			hash: String(row.hash ?? ""),
		}));
}

/**
 * Capture ids that must never decay below full: the newest capture, the
 * nearest capture at-or-before each epoch ts (the anchor `dbg after` resolves
 * for that epoch), and every capture referenced by a diffs row.
 */
export function protectedCaptureIds(
	captures: Array<{ id: number; ts: number }>,
	epochTimestamps: number[],
	diffCaptureIds: number[],
): Set<number> {
	const ids = new Set<number>(diffCaptureIds);
	if (captures.length === 0) return ids;
	ids.add(captures[captures.length - 1].id); // newest
	for (const ts of epochTimestamps) {
		// Mirrors anchor.ts lastAtOrBefore: nearest at-or-before, else first.
		let found: number | null = null;
		for (const c of captures) {
			if (c.ts <= ts) found = c.id;
			else break;
		}
		ids.add(found ?? captures[0].id);
	}
	return ids;
}

/**
 * Order decay candidates: within each epoch the first and last captures are
 * keyframes and decay after the intermediates; otherwise oldest first.
 */
export function decayOrder<T extends { id: number; epochId: number | null }>(
	candidates: T[],
	allCaptures: Array<{ id: number; epochId: number | null }>,
): T[] {
	const edges = new Set<number>();
	const byEpoch = new Map<string, Array<{ id: number }>>();
	for (const c of allCaptures) {
		const key = String(c.epochId);
		const group = byEpoch.get(key) ?? [];
		group.push(c);
		byEpoch.set(key, group);
	}
	for (const group of byEpoch.values()) {
		edges.add(group[0].id);
		edges.add(group[group.length - 1].id);
	}
	return [...candidates].sort((a, b) => {
		const edgeA = edges.has(a.id) ? 1 : 0;
		const edgeB = edges.has(b.id) ? 1 : 0;
		if (edgeA !== edgeB) return edgeA - edgeB;
		return a.id - b.id;
	});
}

/** Rows (excluding meta tier) referencing a blob path, other than `exceptId`. */
function blobRefCount(
	store: RetentionStore,
	sessionName: string,
	blobPath: string,
	exceptId: number,
): number {
	const rows = store.query(
		`SELECT COUNT(*) AS c FROM captures
		 WHERE session_id = ? AND tier != 'meta' AND id != ?
		   AND (png_path = ? OR snapshot_path = ?)`,
		[sessionName, exceptId, blobPath, blobPath],
	);
	return Number(rows[0]?.c ?? 0);
}

/** Delete a blob file if no live (non-meta) capture row still references it. */
function deleteBlobIfUnreferenced(
	store: RetentionStore,
	sessionName: string,
	blobPath: string,
	exceptId: number,
	deleted: string[],
): void {
	if (!blobPath) return;
	if (blobRefCount(store, sessionName, blobPath, exceptId) > 0) return;
	try {
		fs.unlinkSync(blobPath);
		deleted.push(blobPath);
	} catch {
		// already gone; the row update below is what matters
	}
}

function statSize(filePath: string, cache: Map<string, number>): number {
	const cached = cache.get(filePath);
	if (cached !== undefined) return cached;
	let size = 0;
	try {
		size = fs.statSync(filePath).size;
	} catch {
		// missing blob counts as zero bytes
	}
	cache.set(filePath, size);
	return size;
}

/** Distinct blob paths referenced by non-meta rows. */
function liveBlobPaths(rows: CaptureRow[]): Set<string> {
	const paths = new Set<string>();
	for (const row of rows) {
		if (row.tier === "meta") continue;
		if (row.pngPath) paths.add(row.pngPath);
		if (row.snapshotPath) paths.add(row.snapshotPath);
	}
	return paths;
}

/** Total bytes of the session's live (non-meta-referenced) blobs. */
export function sessionBlobBytes(
	store: RetentionStore,
	sessionName: string,
): number {
	const cache = new Map<string, number>();
	let total = 0;
	for (const blob of liveBlobPaths(captureRows(store, sessionName))) {
		total += statSize(blob, cache);
	}
	return total;
}

export interface RetentionStats {
	diskBytes: number;
	fullFrames: number;
	thumbFrames: number;
	metaFrames: number;
}

export function sessionRetentionStats(
	store: RetentionStore,
	sessionName: string,
): RetentionStats {
	const rows = captureRows(store, sessionName);
	const cache = new Map<string, number>();
	let diskBytes = 0;
	for (const blob of liveBlobPaths(rows)) {
		diskBytes += statSize(blob, cache);
	}
	return {
		diskBytes,
		fullFrames: rows.filter((r) => r.tier === "full").length,
		thumbFrames: rows.filter((r) => r.tier === "thumb").length,
		metaFrames: rows.filter((r) => r.tier === "meta").length,
	};
}

/** full → thumb: write the (content-addressed) thumb blob, repoint the row,
 * then drop the original blob if nothing else references it. */
function decayToThumb(
	store: RetentionStore,
	sessionName: string,
	row: CaptureRow,
	recordingDir: string,
	result: RetentionResult,
): void {
	const thumbPath = path.join(recordingDir, "blobs", `${row.hash}-thumb.png`);
	if (!fs.existsSync(thumbPath)) {
		let original: Buffer;
		try {
			original = fs.readFileSync(row.pngPath);
		} catch {
			// Blob already gone (external cleanup): nothing to thumb — decay
			// straight to metadata-only so the row's tier matches reality.
			decayToMeta(store, sessionName, row, result);
			return;
		}
		fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
		fs.writeFileSync(thumbPath, downscalePng(original, THUMB_MAX_WIDTH));
	}
	const oldPng = row.pngPath;
	store.run("UPDATE captures SET tier = 'thumb', png_path = ? WHERE id = ?", [
		thumbPath,
		row.id,
	]);
	row.tier = "thumb";
	row.pngPath = thumbPath;
	deleteBlobIfUnreferenced(
		store,
		sessionName,
		oldPng,
		row.id,
		result.deletedBlobs,
	);
	result.decayedToThumb.push(row.id);
}

/** thumb → meta: mark the row, then drop its png + snapshot blobs if no
 * other live row references them. Paths stay on the row as history. */
function decayToMeta(
	store: RetentionStore,
	sessionName: string,
	row: CaptureRow,
	result: RetentionResult,
): void {
	store.run("UPDATE captures SET tier = 'meta' WHERE id = ?", [row.id]);
	row.tier = "meta";
	deleteBlobIfUnreferenced(
		store,
		sessionName,
		row.pngPath,
		row.id,
		result.deletedBlobs,
	);
	if (row.snapshotPath) {
		deleteBlobIfUnreferenced(
			store,
			sessionName,
			row.snapshotPath,
			row.id,
			result.deletedBlobs,
		);
	}
	result.decayedToMeta.push(row.id);
}

/**
 * Enforce the tiered decay ring buffer. Runs after each capture insert;
 * cheap when under budget (one SELECT + stat of live blobs).
 */
export function applyRetention(
	store: RetentionStore,
	sessionName: string,
	recordingDir: string,
	cfg: RetentionConfig,
): RetentionResult {
	const result: RetentionResult = {
		decayedToThumb: [],
		decayedToMeta: [],
		deletedBlobs: [],
	};
	const rows = captureRows(store, sessionName);
	if (rows.length === 0) return result;

	const epochTs = store
		.query("SELECT ts FROM epochs WHERE session_id = ? ORDER BY id", [
			sessionName,
		])
		.map((r) => Number(r.ts));
	const diffIds = store
		.query("SELECT baseline_capture_id, after_capture_id FROM diffs")
		.flatMap((r) => [
			Number(r.baseline_capture_id),
			Number(r.after_capture_id),
		]);
	const protectedIds = protectedCaptureIds(rows, epochTs, diffIds);

	// ── Frame-count budget: decay oldest non-keyframe fulls to thumb ──
	const fullCandidates = decayOrder(
		rows.filter((r) => r.tier === "full" && !protectedIds.has(r.id)),
		rows,
	);
	let fullCount = rows.filter((r) => r.tier === "full").length;
	let next = 0;
	while (fullCount > cfg.maxFullFrames && next < fullCandidates.length) {
		decayToThumb(
			store,
			sessionName,
			fullCandidates[next],
			recordingDir,
			result,
		);
		fullCount--;
		next++;
	}

	// ── Byte budget: keep decaying (full→thumb, then thumb→meta) ──
	const sizeCache = new Map<string, number>();
	let totalBytes = 0;
	for (const blob of liveBlobPaths(rows)) {
		totalBytes += statSize(blob, sizeCache);
	}
	const recomputeBytes = (): number => {
		sizeCache.clear();
		let total = 0;
		for (const blob of liveBlobPaths(rows)) {
			total += statSize(blob, sizeCache);
		}
		return total;
	};
	while (totalBytes > cfg.maxBytes && next < fullCandidates.length) {
		decayToThumb(
			store,
			sessionName,
			fullCandidates[next],
			recordingDir,
			result,
		);
		next++;
		totalBytes = recomputeBytes();
	}
	if (totalBytes > cfg.maxBytes) {
		const thumbCandidates = decayOrder(
			rows.filter((r) => r.tier === "thumb" && !protectedIds.has(r.id)),
			rows,
		);
		for (const row of thumbCandidates) {
			if (totalBytes <= cfg.maxBytes) break;
			decayToMeta(store, sessionName, row, result);
			totalBytes = recomputeBytes();
		}
	}
	return result;
}
