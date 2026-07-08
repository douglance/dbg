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

// Bump whenever any table shape changes. The events DB is scratch/debug data:
// on a version mismatch (or an unreadable schema) the known tables are dropped
// and rebuilt rather than migrated — a dbg upgrade must never crash on an
// existing DB.
export const SCHEMA_VERSION = 9;

const KNOWN_TABLES = [
	"events",
	"captures",
	"epochs",
	"diffs",
	"regions",
	"edits",
	"state_snapshots",
	"a11y_issues",
	"taps",
	"tap_hits",
	"perf_samples",
	"flows",
	"flow_steps",
	"flow_runs",
	"flow_run_steps",
];

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
	snapshotPath?: string | null;
	/** Gzipped Accessibility.getFullAXTree blob path (retention-managed). */
	axPath?: string | null;
	/** Retention tier: 'full' (default) | 'thumb' | 'meta'. */
	tier?: CaptureTier;
}

export type CaptureTier = "full" | "thumb" | "meta";

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

export interface EditRecord {
	ts?: number;
	path: string;
	epochId?: number | null;
	sessionId: string;
}

export interface StateSnapshotRecord {
	ts?: number;
	captureId: number;
	/** 'localStorage' | 'sessionStorage'. */
	kind: string;
	/** JSON string of the storage entries at capture time. */
	data: string;
}

export interface A11yIssueRecord {
	ts?: number;
	captureId: number;
	rule: string;
	selector: string;
	detail: string;
}

export interface PerfSampleRecord {
	ts?: number;
	navId: number;
	captureId: number | null;
	metric: string;
	value: number;
	detail: string | null;
}

export interface TapRecord {
	sessionId: string;
	breakpointId: string;
	file: string;
	/** 1-based line as the user typed it. */
	line: number;
	expr: string;
	urlRegex: string;
	enabled?: boolean;
	createdTs?: number;
}

export interface TapHitRecord {
	tapId: number;
	ts?: number;
	/** The stringified expression value the logpoint emitted. */
	value: string;
}

export interface FlowRecord {
	ts?: number;
	name: string;
	url: string;
	sessionId: string;
}

export interface FlowStepRecord {
	flowId: number;
	idx: number;
	kind: string;
	selector?: string | null;
	fallbackPath?: string | null;
	value?: string | null;
	detail?: string | null;
}

export interface FlowRunRecord {
	ts?: number;
	flowId: number;
	status: string;
	stepsTotal: number;
	stepsPassed: number;
}

export interface FlowRunStepRecord {
	runId: number;
	stepId: number;
	idx: number;
	kind: string;
	status: string;
	captureId?: number | null;
	error?: string | null;
	diffPercent?: number | null;
}

export interface RegionRecord {
	diffId: number;
	x: number;
	y: number;
	w: number;
	h: number;
	component?: string | null;
	file?: string | null;
	causal?: boolean;
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
	private insertStmt!: StatementSync;
	private insertCaptureStmt!: StatementSync;
	private insertEpochStmt!: StatementSync;
	private insertDiffStmt!: StatementSync;
	private insertRegionStmt!: StatementSync;
	private insertEditStmt!: StatementSync;
	private insertStateSnapshotStmt!: StatementSync;
	private insertA11yIssueStmt!: StatementSync;
	private insertPerfSampleStmt!: StatementSync;
	private insertTapStmt!: StatementSync;
	private insertTapHitStmt!: StatementSync;
	private insertFlowStmt!: StatementSync;
	private insertFlowStepStmt!: StatementSync;
	private insertFlowRunStmt!: StatementSync;
	private insertFlowRunStepStmt!: StatementSync;
	private pending: PendingEvent[] = [];
	private flushTimer: NodeJS.Timeout;
	private closed = false;

	constructor(dbPath = process.env.DBG_EVENTS_DB ?? "/tmp/dbg-events.db") {
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");

		// Schema guard: on version mismatch, rebuild from scratch.
		if (this.readUserVersion() !== SCHEMA_VERSION) {
			this.dropKnownTables();
		}
		try {
			this.createTables();
			this.prepareStatements();
		} catch {
			// Same version but a mismatched shape (hand-edited or corrupted DB):
			// rebuild once, then let a genuine failure propagate.
			this.dropKnownTables();
			this.createTables();
			this.prepareStatements();
		}
		this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

		this.flushTimer = setInterval(() => {
			this.flush();
		}, 100);
		if (this.flushTimer.unref) this.flushTimer.unref();
	}

	private readUserVersion(): number {
		try {
			const row = this.db.prepare("PRAGMA user_version").get();
			return Number(row?.user_version ?? 0);
		} catch {
			return -1;
		}
	}

	private dropKnownTables(): void {
		for (const table of KNOWN_TABLES) {
			try {
				this.db.exec(`DROP TABLE IF EXISTS ${table}`);
			} catch {
				// a table we cannot even drop will surface on CREATE below
			}
		}
	}

	private createTables(): void {
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
		// PNGs and gzipped DOM/style snapshots live on disk; only metadata here.
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
				epoch_id INTEGER,
				snapshot_path TEXT,
				ax_path TEXT,
				tier TEXT NOT NULL DEFAULT 'full'
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
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS regions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				diff_id INTEGER NOT NULL,
				x REAL NOT NULL,
				y REAL NOT NULL,
				w REAL NOT NULL,
				h REAL NOT NULL,
				component TEXT,
				file TEXT,
				causal INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_regions_diff_id ON regions(diff_id)",
		);

		// File edits: one row per fs-watch event during recording (the raw
		// edit stream). Retention/TTL pruning never touches this table — these
		// are cheap metadata rows kept for blame/timeline joins.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS edits (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				path TEXT NOT NULL,
				epoch_id INTEGER,
				session_id TEXT NOT NULL
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_edits_ts ON edits(ts)");
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_edits_session_id ON edits(session_id)",
		);

		// App state snapshots (local/sessionStorage dumps per capture) and
		// computed accessibility issues per capture — both metadata (kept; not
		// pruned by retention/TTL), keyed to a capture id.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS state_snapshots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				capture_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				data TEXT NOT NULL
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_state_snapshots_capture_id ON state_snapshots(capture_id)",
		);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS a11y_issues (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				capture_id INTEGER NOT NULL,
				rule TEXT NOT NULL,
				selector TEXT NOT NULL,
				detail TEXT NOT NULL
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_a11y_issues_capture_id ON a11y_issues(capture_id)",
		);

		// Plan X perf flight recorder: PerformanceObserver batches (capture_id
		// NULL) + per-capture Performance.getMetrics / bundle_bytes samples.
		// Metadata (kept; not pruned by retention/TTL), indexed by capture_id.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS perf_samples (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				nav_id INTEGER NOT NULL,
				capture_id INTEGER,
				metric TEXT NOT NULL,
				value REAL NOT NULL,
				detail TEXT
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_perf_samples_capture_id ON perf_samples(capture_id)",
		);

		// Taps (logpoints): a conditioned breakpoint that never pauses, emitting
		// an expression value via a console sentinel. tap_hits records each fire.
		// Metadata — never pruned by retention/TTL.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS taps (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				breakpoint_id TEXT NOT NULL,
				file TEXT NOT NULL,
				line INTEGER NOT NULL,
				expr TEXT NOT NULL,
				url_regex TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_ts INTEGER NOT NULL
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_taps_session_id ON taps(session_id)",
		);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tap_hits (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tap_id INTEGER NOT NULL,
				ts INTEGER NOT NULL,
				value TEXT NOT NULL
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_tap_hits_tap_id ON tap_hits(tap_id)",
		);

		// Plan Y flows: recorded user actions and replay verdicts. Kept as
		// durable metadata for repeatable regression checks.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS flows (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				name TEXT NOT NULL,
				url TEXT NOT NULL,
				session_id TEXT NOT NULL
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_flows_name ON flows(name)");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS flow_steps (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				flow_id INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				kind TEXT NOT NULL,
				selector TEXT,
				fallback_path TEXT,
				value TEXT,
				detail TEXT
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_flow_steps_flow_id ON flow_steps(flow_id)",
		);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS flow_runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				flow_id INTEGER NOT NULL,
				status TEXT NOT NULL,
				steps_total INTEGER NOT NULL,
				steps_passed INTEGER NOT NULL
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_flow_runs_flow_id ON flow_runs(flow_id)",
		);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS flow_run_steps (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id INTEGER NOT NULL,
				step_id INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				kind TEXT NOT NULL,
				status TEXT NOT NULL,
				capture_id INTEGER,
				error TEXT,
				diff_percent REAL
			)
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_flow_run_steps_run_id ON flow_run_steps(run_id)",
		);
	}

	private prepareStatements(): void {
		this.insertStmt = this.db.prepare(
			"INSERT INTO events (ts, source, category, method, data, session_id) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.insertCaptureStmt = this.db.prepare(
			`INSERT INTO captures (ts, session_id, url, scroll_y, dpr, hash, png_path, changed_files, hmr_modules, epoch_id, snapshot_path, ax_path, tier)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertEpochStmt = this.db.prepare(
			"INSERT INTO epochs (ts, session_id, name, auto) VALUES (?, ?, ?, ?)",
		);
		this.insertDiffStmt = this.db.prepare(
			`INSERT INTO diffs (ts, name, baseline_capture_id, after_capture_id, diff_percent, diff_pixels, report_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertRegionStmt = this.db.prepare(
			`INSERT INTO regions (diff_id, x, y, w, h, component, file, causal)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertEditStmt = this.db.prepare(
			"INSERT INTO edits (ts, path, epoch_id, session_id) VALUES (?, ?, ?, ?)",
		);
		this.insertStateSnapshotStmt = this.db.prepare(
			"INSERT INTO state_snapshots (ts, capture_id, kind, data) VALUES (?, ?, ?, ?)",
		);
		this.insertA11yIssueStmt = this.db.prepare(
			"INSERT INTO a11y_issues (ts, capture_id, rule, selector, detail) VALUES (?, ?, ?, ?, ?)",
		);
		this.insertPerfSampleStmt = this.db.prepare(
			"INSERT INTO perf_samples (ts, nav_id, capture_id, metric, value, detail) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.insertTapStmt = this.db.prepare(
			`INSERT INTO taps (session_id, breakpoint_id, file, line, expr, url_regex, enabled, created_ts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertTapHitStmt = this.db.prepare(
			"INSERT INTO tap_hits (tap_id, ts, value) VALUES (?, ?, ?)",
		);
		this.insertFlowStmt = this.db.prepare(
			"INSERT INTO flows (ts, name, url, session_id) VALUES (?, ?, ?, ?)",
		);
		this.insertFlowStepStmt = this.db.prepare(
			`INSERT INTO flow_steps (flow_id, idx, kind, selector, fallback_path, value, detail)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertFlowRunStmt = this.db.prepare(
			`INSERT INTO flow_runs (ts, flow_id, status, steps_total, steps_passed)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		this.insertFlowRunStepStmt = this.db.prepare(
			`INSERT INTO flow_run_steps (run_id, step_id, idx, kind, status, capture_id, error, diff_percent)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
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
			capture.snapshotPath ?? null,
			capture.axPath ?? null,
			capture.tier ?? "full",
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

	/** Insert blame regions for a diff; returns inserted row ids. */
	insertRegions(regions: RegionRecord[]): number[] {
		if (this.closed) return [];
		const ids: number[] = [];
		for (const region of regions) {
			const result = this.insertRegionStmt.run(
				region.diffId,
				region.x,
				region.y,
				region.w,
				region.h,
				region.component ?? null,
				region.file ?? null,
				region.causal ? 1 : 0,
			);
			ids.push(Number(result.lastInsertRowid));
		}
		return ids;
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

	/** Insert a file-edit row; returns its id (-1 if the store is closed). */
	insertEdit(edit: EditRecord): number {
		if (this.closed) return -1;
		const result = this.insertEditStmt.run(
			edit.ts ?? Date.now(),
			edit.path,
			edit.epochId ?? null,
			edit.sessionId,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert an app-state snapshot row; returns its id (-1 if closed). */
	insertStateSnapshot(snapshot: StateSnapshotRecord): number {
		if (this.closed) return -1;
		const result = this.insertStateSnapshotStmt.run(
			snapshot.ts ?? Date.now(),
			snapshot.captureId,
			snapshot.kind,
			snapshot.data,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert accessibility issue rows for a capture; returns inserted ids. */
	insertA11yIssues(issues: A11yIssueRecord[]): number[] {
		if (this.closed) return [];
		const ids: number[] = [];
		for (const issue of issues) {
			const result = this.insertA11yIssueStmt.run(
				issue.ts ?? Date.now(),
				issue.captureId,
				issue.rule,
				issue.selector,
				issue.detail,
			);
			ids.push(Number(result.lastInsertRowid));
		}
		return ids;
	}

	/** Insert perf_samples rows (observer batch or per-capture metrics); returns
	 * inserted ids. */
	insertPerfSamples(rows: PerfSampleRecord[]): number[] {
		if (this.closed) return [];
		const ids: number[] = [];
		for (const row of rows) {
			const result = this.insertPerfSampleStmt.run(
				row.ts ?? Date.now(),
				row.navId,
				row.captureId ?? null,
				row.metric,
				row.value,
				row.detail ?? null,
			);
			ids.push(Number(result.lastInsertRowid));
		}
		return ids;
	}

	/** Insert a tap (logpoint) row; returns its id (-1 if closed). */
	insertTap(tap: TapRecord): number {
		if (this.closed) return -1;
		const result = this.insertTapStmt.run(
			tap.sessionId,
			tap.breakpointId,
			tap.file,
			tap.line,
			tap.expr,
			tap.urlRegex,
			tap.enabled === false ? 0 : 1,
			tap.createdTs ?? Date.now(),
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert a tap-hit row; returns its id (-1 if closed). */
	insertTapHit(hit: TapHitRecord): number {
		if (this.closed) return -1;
		const result = this.insertTapHitStmt.run(
			hit.tapId,
			hit.ts ?? Date.now(),
			hit.value,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert a named recorded flow; returns its id (-1 if closed). */
	insertFlow(flow: FlowRecord): number {
		if (this.closed) return -1;
		const result = this.insertFlowStmt.run(
			flow.ts ?? Date.now(),
			flow.name,
			flow.url,
			flow.sessionId,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert a recorded flow step; returns its id (-1 if closed). */
	insertFlowStep(step: FlowStepRecord): number {
		if (this.closed) return -1;
		const result = this.insertFlowStepStmt.run(
			step.flowId,
			step.idx,
			step.kind,
			step.selector ?? null,
			step.fallbackPath ?? null,
			step.value ?? null,
			step.detail ?? null,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert a flow replay run; returns its id (-1 if closed). */
	insertFlowRun(run: FlowRunRecord): number {
		if (this.closed) return -1;
		const result = this.insertFlowRunStmt.run(
			run.ts ?? Date.now(),
			run.flowId,
			run.status,
			run.stepsTotal,
			run.stepsPassed,
		);
		return Number(result.lastInsertRowid);
	}

	/** Insert a per-step flow replay verdict; returns its id (-1 if closed). */
	insertFlowRunStep(step: FlowRunStepRecord): number {
		if (this.closed) return -1;
		const result = this.insertFlowRunStepStmt.run(
			step.runId,
			step.stepId,
			step.idx,
			step.kind,
			step.status,
			step.captureId ?? null,
			step.error ?? null,
			step.diffPercent ?? null,
		);
		return Number(result.lastInsertRowid);
	}

	/** Execute a write statement (UPDATE/DELETE); returns affected row count. */
	run(sql: string, params: unknown[] = []): number {
		if (this.closed) return 0;
		this.flush();
		const stmt = this.db.prepare(sql);
		const runFn = stmt.run.bind(stmt) as (...args: unknown[]) => {
			changes: number | bigint;
		};
		return Number(runFn(...params).changes);
	}

	/**
	 * Delete raw `events` rows older than ttlMs, but always keep the
	 * most-recent `floorRows` rows regardless of age. Returns rows deleted.
	 *
	 * Interaction with `dbg after` deltas: console/network deltas only read
	 * events NEWER than the anchor capture's timestamp, and anchor captures
	 * are protected from decay — so pruning rows older than the TTL window
	 * never removes data a delta within that window can reference.
	 */
	pruneEvents(ttlMs: number, floorRows = 50_000): number {
		if (this.closed) return 0;
		this.flush();
		const floorStmt = this.db.prepare(
			"SELECT MIN(id) AS floor FROM (SELECT id FROM events ORDER BY id DESC LIMIT ?)",
		);
		const getFloor = floorStmt.get.bind(floorStmt) as (
			...args: unknown[]
		) => { floor?: number | bigint | null } | undefined;
		const floorId = getFloor(floorRows)?.floor;
		if (floorId == null) return 0;
		return this.run("DELETE FROM events WHERE ts < ? AND id < ?", [
			Date.now() - ttlMs,
			Number(floorId),
		]);
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
