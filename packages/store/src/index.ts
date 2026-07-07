import { createRequire } from "node:module";
import type {
	DatabaseSync as DatabaseSyncType,
	StatementSync,
} from "node:sqlite";

const require = createRequire(import.meta.url);
const SQLITE_MODULE = "node:sqlite";
const { DatabaseSync } = require(SQLITE_MODULE) as {
	DatabaseSync: new (path?: string) => DatabaseSyncType;
};

export interface EventRecord {
	ts?: number;
	source: string;
	category: string;
	method: string;
	data?: unknown;
	sessionId?: string | null;
}

export interface CaptureRecord {
	ts?: number;
	sessionId: string;
	url: string;
	scrollY?: number;
	dpr?: number;
	hash: string;
	pngPath: string;
	changedFiles?: string[];
	hmrModules?: string[];
	epochId?: number | null;
}

export interface EpochRecord {
	ts?: number;
	sessionId: string;
	name?: string | null;
	auto?: boolean;
}

export interface DiffRecord {
	ts?: number;
	name: string;
	baselineCaptureId: number;
	afterCaptureId: number;
	diffPercent: number;
	diffPixels: number;
	reportPath: string;
}

interface PendingEvent {
	ts: number;
	source: string;
	category: string;
	method: string;
	data: string;
	sessionId: string | null;
}

export class EventStore {
	private db: DatabaseSyncType;
	private insertStmt: StatementSync;
	private insertCaptureStmt: StatementSync;
	private insertEpochStmt: StatementSync;
	private insertDiffStmt: StatementSync;
	private pending: PendingEvent[] = [];
	private flushTimer: NodeJS.Timeout;
	private closed = false;

	constructor(dbPath = process.env.DBG_EVENTS_DB ?? "/tmp/dbg-events.db") {
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA user_version = 1");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				source TEXT NOT NULL,
				category TEXT NOT NULL,
				method TEXT NOT NULL,
				data TEXT NOT NULL,
				session_id TEXT
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)");
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)",
		);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_events_method ON events(method)",
		);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)",
		);

		// Visual flight recorder: screenshot capture metadata + epoch markers.
		// PNGs live on disk; only metadata is stored here.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS captures (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				url TEXT NOT NULL,
				scroll_y REAL NOT NULL DEFAULT 0,
				dpr REAL NOT NULL DEFAULT 1,
				hash TEXT NOT NULL,
				png_path TEXT NOT NULL,
				changed_files TEXT NOT NULL DEFAULT '[]',
				hmr_modules TEXT NOT NULL DEFAULT '[]',
				epoch_id INTEGER
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_captures_ts ON captures(ts)");
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_captures_session_id ON captures(session_id)",
		);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS epochs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				name TEXT,
				auto INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_epochs_ts ON epochs(ts)");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS diffs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				name TEXT NOT NULL,
				baseline_capture_id INTEGER NOT NULL,
				after_capture_id INTEGER NOT NULL,
				diff_percent REAL NOT NULL,
				diff_pixels INTEGER NOT NULL,
				report_path TEXT NOT NULL
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_diffs_ts ON diffs(ts)");

		this.insertStmt = this.db.prepare(
			"INSERT INTO events (ts, source, category, method, data, session_id) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.insertCaptureStmt = this.db.prepare(
			`INSERT INTO captures (ts, session_id, url, scroll_y, dpr, hash, png_path, changed_files, hmr_modules, epoch_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertEpochStmt = this.db.prepare(
			"INSERT INTO epochs (ts, session_id, name, auto) VALUES (?, ?, ?, ?)",
		);
		this.insertDiffStmt = this.db.prepare(
			`INSERT INTO diffs (ts, name, baseline_capture_id, after_capture_id, diff_percent, diff_pixels, report_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		this.flushTimer = setInterval(() => {
			this.flush();
		}, 100);
		if (this.flushTimer.unref) this.flushTimer.unref();
	}

	record(event: EventRecord, flushNow = false): void {
		if (this.closed) return;
		this.pending.push({
			ts: event.ts ?? Date.now(),
			source: event.source,
			category: event.category,
			method: event.method,
			data: safeJsonStringify(event.data),
			sessionId: event.sessionId ?? null,
		});
		if (flushNow) {
			this.flush();
		}
	}

	flush(): void {
		if (this.closed || this.pending.length === 0) return;

		const batch = this.pending;
		this.pending = [];

		try {
			this.db.exec("BEGIN");
			for (const event of batch) {
				this.insertStmt.run(
					event.ts,
					event.source,
					event.category,
					event.method,
					event.data,
					event.sessionId,
				);
			}
			this.db.exec("COMMIT");
		} catch {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// ignore rollback errors
			}
			this.pending = [...batch, ...this.pending];
		}
	}

	/** Insert a recorder capture row; returns its id (-1 if the store is closed). */
	insertCapture(capture: CaptureRecord): number {
		if (this.closed) return -1;
		const result = this.insertCaptureStmt.run(
			capture.ts ?? Date.now(),
			capture.sessionId,
			capture.url,
			capture.scrollY ?? 0,
			capture.dpr ?? 1,
			capture.hash,
			capture.pngPath,
			JSON.stringify(capture.changedFiles ?? []),
			JSON.stringify(capture.hmrModules ?? []),
			capture.epochId ?? null,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert a pixel-diff result row; returns its id (-1 if the store is closed). */
	insertDiff(diff: DiffRecord): number {
		if (this.closed) return -1;
		const result = this.insertDiffStmt.run(
			diff.ts ?? Date.now(),
			diff.name,
			diff.baselineCaptureId,
			diff.afterCaptureId,
			diff.diffPercent,
			diff.diffPixels,
			diff.reportPath,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert an epoch marker row; returns its id (-1 if the store is closed). */
	insertEpoch(epoch: EpochRecord): number {
		if (this.closed) return -1;
		const result = this.insertEpochStmt.run(
			epoch.ts ?? Date.now(),
			epoch.sessionId,
			epoch.name ?? null,
			epoch.auto ? 1 : 0,
		);
		return Number(result.lastInsertRowid);
	}

	query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
		if (this.closed) return [];
		this.flush();
		const stmt = this.db.prepare(sql);
		// Cast: @types/node's node:sqlite typings restrict params to
		// SQLInputValue, which is not exported by every version in range.
		const all = stmt.all.bind(stmt) as (
			...args: unknown[]
		) => Record<string, unknown>[];
		return all(...params);
	}

	close(): void {
		if (this.closed) return;
		clearInterval(this.flushTimer);
		this.flush();
		this.db.close();
		this.closed = true;
	}
}

function safeJsonStringify(value: unknown): string {
	if (value === undefined) return "null";
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ error: "unserializable" });
	}
}
