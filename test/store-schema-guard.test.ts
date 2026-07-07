// Part 0 (Phase 4): the events DB is scratch data — opening a DB written by
// an older/different dbg schema must rebuild it, never crash.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore, SCHEMA_VERSION } from "../packages/store/src/index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
	DatabaseSync: new (path: string) => {
		exec(sql: string): void;
		prepare(sql: string): {
			get(...p: unknown[]): Record<string, unknown> | undefined;
			all(...p: unknown[]): Record<string, unknown>[];
		};
		close(): void;
	};
};

const tmpDirs: string[] = [];
function tmpDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-schema-"));
	tmpDirs.push(dir);
	return path.join(dir, "events.db");
}

afterEach(() => {
	while (tmpDirs.length) {
		const dir = tmpDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function currentSchemaWorks(store: EventStore): void {
	expect(
		store.insertDiff({
			name: "a → b",
			baselineCaptureId: 1,
			afterCaptureId: 2,
			diffPercent: 1.5,
			diffPixels: 10,
			reportPath: "/tmp/report.html",
		}),
	).toBeGreaterThan(0);
	expect(
		store.insertCapture({
			sessionId: "recorder",
			url: "http://x/",
			hash: "abc",
			pngPath: "/tmp/x.png",
			snapshotPath: "/tmp/x.json.gz",
		}),
	).toBeGreaterThan(0);
	expect(
		store.insertRegions([
			{ diffId: 1, x: 0, y: 0, w: 10, h: 10, component: "Card" },
		]).length,
	).toBe(1);
	const row = store.query("SELECT snapshot_path FROM captures LIMIT 1");
	expect(row[0].snapshot_path).toBe("/tmp/x.json.gz");
}

describe("EventStore schema guard", () => {
	it("rebuilds a DB created with an older schema (missing columns)", () => {
		const dbPath = tmpDb();
		// Phase-3-era diffs shape (session_id instead of name/baseline) at the
		// old version stamp.
		const old = new DatabaseSync(dbPath);
		old.exec("PRAGMA user_version = 1");
		old.exec(
			"CREATE TABLE diffs (id INTEGER PRIMARY KEY, session_id TEXT, anchor_capture_id INTEGER)",
		);
		old.exec("CREATE TABLE captures (id INTEGER PRIMARY KEY, ts INTEGER)");
		old.close();

		const store = new EventStore(dbPath);
		currentSchemaWorks(store);
		store.close();

		const check = new DatabaseSync(dbPath);
		const version = check.prepare("PRAGMA user_version").get();
		expect(Number(version?.user_version)).toBe(SCHEMA_VERSION);
		check.close();
	});

	it("rebuilds when the version stamp matches but a table shape does not", () => {
		const dbPath = tmpDb();
		const old = new DatabaseSync(dbPath);
		old.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		old.exec("CREATE TABLE diffs (id INTEGER PRIMARY KEY, wrong_column TEXT)");
		old.close();

		const store = new EventStore(dbPath);
		currentSchemaWorks(store);
		store.close();
	});

	it("keeps data on a same-version reopen", () => {
		const dbPath = tmpDb();
		const first = new EventStore(dbPath);
		const id = first.insertEpoch({ sessionId: "recorder", name: "keep" });
		expect(id).toBeGreaterThan(0);
		first.close();

		const second = new EventStore(dbPath);
		const rows = second.query("SELECT name FROM epochs");
		expect(rows.map((r) => r.name)).toContain("keep");
		second.close();
	});

	it("opens a brand new DB at the current version", () => {
		const store = new EventStore(tmpDb());
		currentSchemaWorks(store);
		store.close();
	});
});
