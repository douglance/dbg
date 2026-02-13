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

		this.insertStmt = this.db.prepare(
			"INSERT INTO events (ts, source, category, method, data, session_id) VALUES (?, ?, ?, ?, ?, ?)",
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

	query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
		if (this.closed) return [];
		this.flush();
		const stmt = this.db.prepare(sql);
		return stmt.all(...params) as Record<string, unknown>[];
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
