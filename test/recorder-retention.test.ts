// Retention unit tests: content-addressed blob refcounting, tiered decay
// ordering (epoch keyframes + diff baselines + newest survive), pngjs
// downscale, and the raw-events TTL prune. No Chrome needed — captures are
// synthetic rows over pngjs-generated blobs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { downscalePng } from "../packages/diff/src/index.js";
import {
	applyRetention,
	decayOrder,
	protectedCaptureIds,
	sessionRetentionStats,
} from "../packages/cli/src/recorder/retention.js";
import { EventStore } from "../packages/store/src/index.js";

const SESSION = "recorder";

const tmpDirs: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-retention-"));
	tmpDirs.push(dir);
	return dir;
}

let store: EventStore | null = null;

afterEach(() => {
	store?.close();
	store = null;
	while (tmpDirs.length) {
		const dir = tmpDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** Solid-color PNG of the given size. */
function makePng(width: number, height: number, seed = 0): Buffer {
	const png = new PNG({ width, height });
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = (seed * 37) % 256;
		png.data[i + 1] = (seed * 101) % 256;
		png.data[i + 2] = (seed * 199) % 256;
		png.data[i + 3] = 255;
	}
	return PNG.sync.write(png);
}

interface TestRecording {
	recordingDir: string;
	/** Write a content-addressed blob and insert a capture row over it. */
	addCapture(opts: {
		ts: number;
		hash: string;
		seed?: number;
		epochId?: number | null;
		width?: number;
	}): number;
}

function makeRecording(eventStore: EventStore): TestRecording {
	const recordingDir = path.join(tmpDir(), "recordings", SESSION);
	const blobsDir = path.join(recordingDir, "blobs");
	fs.mkdirSync(blobsDir, { recursive: true });
	return {
		recordingDir,
		addCapture({ ts, hash, seed = 1, epochId = null, width = 640 }) {
			const pngPath = path.join(blobsDir, `${hash}.png`);
			if (!fs.existsSync(pngPath)) {
				fs.writeFileSync(pngPath, makePng(width, 480, seed));
			}
			return eventStore.insertCapture({
				ts,
				sessionId: SESSION,
				url: "http://localhost:3000/",
				hash,
				pngPath,
			});
		},
	};
}

function tiers(eventStore: EventStore): Map<number, string> {
	const map = new Map<number, string>();
	for (const row of eventStore.query(
		"SELECT id, tier FROM captures WHERE session_id = ? ORDER BY id",
		[SESSION],
	)) {
		map.set(Number(row.id), String(row.tier));
	}
	return map;
}

describe("downscalePng", () => {
	it("produces a valid, smaller PNG at most 320px wide", () => {
		const original = makePng(640, 480, 7);
		const thumb = downscalePng(original, 320);
		const decoded = PNG.sync.read(thumb);
		expect(decoded.width).toBe(320);
		expect(decoded.height).toBe(240);
		expect(thumb.length).toBeLessThan(original.length);
	});

	it("returns small sources unchanged", () => {
		const original = makePng(200, 100, 3);
		expect(downscalePng(original, 320)).toBe(original);
	});
});

describe("protectedCaptureIds / decayOrder", () => {
	it("protects the newest, epoch anchors, and diff-referenced captures", () => {
		const captures = [
			{ id: 1, ts: 100 },
			{ id: 2, ts: 200 },
			{ id: 3, ts: 300 },
			{ id: 4, ts: 400 },
		];
		// Epoch at ts 250 → anchor is capture 2 (nearest at-or-before).
		const ids = protectedCaptureIds(captures, [250], [3]);
		expect(ids).toEqual(new Set([2, 3, 4]));
	});

	it("decays epoch intermediates before first/last keyframes", () => {
		const all = [
			{ id: 1, epochId: 10 },
			{ id: 2, epochId: 10 },
			{ id: 3, epochId: 10 },
			{ id: 4, epochId: 11 },
		];
		const ordered = decayOrder(all, all);
		// 2 is the only epoch-10 intermediate; 1/3 are epoch-10 edges, 4 is an
		// epoch-11 edge. Intermediates first, then edges oldest-first.
		expect(ordered.map((c) => c.id)).toEqual([2, 1, 3, 4]);
	});
});

describe("applyRetention", () => {
	it("blob refcounting: two rows → one blob survives the first prune", () => {
		store = new EventStore(":memory:");
		const rec = makeRecording(store);
		// Rows 1 and 2 share blob A (identical content); row 3 has blob B.
		rec.addCapture({ ts: 100, hash: "aaaa", seed: 1 });
		rec.addCapture({ ts: 200, hash: "aaaa", seed: 1 });
		rec.addCapture({ ts: 300, hash: "bbbb", seed: 2 });
		const blobA = path.join(rec.recordingDir, "blobs", "aaaa.png");

		// maxFullFrames 2: one decay. Row 2 (intermediate) goes before row 1
		// (a keyframe edge); row 3 is newest-protected.
		applyRetention(store, SESSION, rec.recordingDir, {
			maxFullFrames: 2,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(tiers(store).get(2)).toBe("thumb");
		expect(tiers(store).get(1)).toBe("full");
		// Blob A still referenced by full row 1 → survives.
		expect(fs.existsSync(blobA)).toBe(true);

		// maxFullFrames 1: row 1 decays too; blob A now unreferenced → deleted.
		applyRetention(store, SESSION, rec.recordingDir, {
			maxFullFrames: 1,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(tiers(store).get(1)).toBe("thumb");
		expect(fs.existsSync(blobA)).toBe(false);
		// Both thumb rows share the content-addressed thumb blob.
		const thumbPath = path.join(rec.recordingDir, "blobs", "aaaa-thumb.png");
		expect(fs.existsSync(thumbPath)).toBe(true);
		const rows = store.query(
			"SELECT png_path FROM captures WHERE id IN (1, 2)",
		);
		expect(rows.map((r) => r.png_path)).toEqual([thumbPath, thumbPath]);
	});

	it("keeps epoch anchors, diff baselines, and the newest at tier full; intermediates decay first", () => {
		store = new EventStore(":memory:");
		const rec = makeRecording(store);
		const epochId = store.insertEpoch({ ts: 150, sessionId: SESSION });
		rec.addCapture({ ts: 100, hash: "c1", seed: 1 }); // epoch anchor (≤150)
		rec.addCapture({ ts: 200, hash: "c2", seed: 2 });
		rec.addCapture({ ts: 300, hash: "c3", seed: 3 }); // diff baseline
		rec.addCapture({ ts: 400, hash: "c4", seed: 4 });
		rec.addCapture({ ts: 500, hash: "c5", seed: 5 }); // newest
		store.insertDiff({
			name: "capture 3 → capture 5",
			baselineCaptureId: 3,
			afterCaptureId: 5,
			diffPercent: 1,
			diffPixels: 10,
			reportPath: "/tmp/report.html",
		});
		void epochId;

		applyRetention(store, SESSION, rec.recordingDir, {
			maxFullFrames: 4,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		const byId = tiers(store);
		expect(byId.get(1)).toBe("full"); // epoch anchor: never below full
		expect(byId.get(3)).toBe("full"); // diff baseline: never below full
		expect(byId.get(5)).toBe("full"); // newest: never below full
		// Oldest unprotected decays first.
		expect(byId.get(2)).toBe("thumb");
		expect(byId.get(4)).toBe("full");
	});

	it("byte budget decays thumbs to meta and deletes their blobs", () => {
		store = new EventStore(":memory:");
		const rec = makeRecording(store);
		rec.addCapture({ ts: 100, hash: "m1", seed: 1 });
		rec.addCapture({ ts: 200, hash: "m2", seed: 2 });
		rec.addCapture({ ts: 300, hash: "m3", seed: 3 });

		// Impossible byte budget: everything unprotected → thumb → meta.
		const result = applyRetention(store, SESSION, rec.recordingDir, {
			maxFullFrames: 100,
			maxBytes: 1,
		});
		const byId = tiers(store);
		expect(byId.get(1)).toBe("meta");
		expect(byId.get(2)).toBe("meta");
		expect(byId.get(3)).toBe("full"); // newest survives even over budget
		// Intermediate (2) decays before the keyframe edge (1).
		expect(result.decayedToMeta).toEqual([2, 1]);
		for (const hash of ["m1", "m2"]) {
			expect(
				fs.existsSync(path.join(rec.recordingDir, "blobs", `${hash}.png`)),
			).toBe(false);
			expect(
				fs.existsSync(
					path.join(rec.recordingDir, "blobs", `${hash}-thumb.png`),
				),
			).toBe(false);
		}

		const stats = sessionRetentionStats(store, SESSION);
		expect(stats.fullFrames).toBe(1);
		expect(stats.thumbFrames).toBe(0);
		expect(stats.metaFrames).toBe(2);
		expect(stats.diskBytes).toBeGreaterThan(0);
	});

	it("is a no-op under budget", () => {
		store = new EventStore(":memory:");
		const rec = makeRecording(store);
		rec.addCapture({ ts: 100, hash: "n1", seed: 1 });
		rec.addCapture({ ts: 200, hash: "n2", seed: 2 });
		const result = applyRetention(store, SESSION, rec.recordingDir, {
			maxFullFrames: 200,
			maxBytes: 100 * 1024 * 1024,
		});
		expect(result.decayedToThumb).toEqual([]);
		expect(result.decayedToMeta).toEqual([]);
		expect([...tiers(store).values()]).toEqual(["full", "full"]);
	});
});

describe("EventStore.pruneEvents", () => {
	it("deletes rows older than the TTL but keeps the recent floor", () => {
		store = new EventStore(":memory:");
		const now = Date.now();
		const old = now - 60 * 60 * 1000; // 1h ago, past a 30min TTL
		for (let i = 0; i < 10; i++) {
			store.record({
				ts: old + i,
				source: "cdp_recv",
				category: "network",
				method: "Network.responseReceived",
				data: { i },
			});
		}
		for (let i = 0; i < 5; i++) {
			store.record({
				ts: now - i,
				source: "cdp_recv",
				category: "network",
				method: "Network.responseReceived",
				data: { i },
			});
		}
		store.flush();

		// Floor 8 keeps the newest 8 rows even though 10 are past the TTL.
		const deleted = store.pruneEvents(30 * 60 * 1000, 8);
		expect(deleted).toBe(7);
		const remaining = store.query("SELECT COUNT(*) AS c FROM events");
		expect(Number(remaining[0].c)).toBe(8);
		// All 5 recent rows survive.
		const recent = store.query(
			"SELECT COUNT(*) AS c FROM events WHERE ts > ?",
			[now - 1000],
		);
		expect(Number(recent[0].c)).toBe(5);
	});

	it("keeps everything when the floor covers the whole table", () => {
		store = new EventStore(":memory:");
		store.record({
			ts: Date.now() - 10 * 60 * 60 * 1000,
			source: "cdp_recv",
			category: "log",
			method: "Log.entryAdded",
			data: {},
		});
		store.flush();
		expect(store.pruneEvents(1000, 50_000)).toBe(0);
		expect(Number(store.query("SELECT COUNT(*) AS c FROM events")[0].c)).toBe(
			1,
		);
	});
});
