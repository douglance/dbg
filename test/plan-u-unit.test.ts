// Plan U unit coverage: first-class `edits` table, SQL materialization
// (JOIN / BETWEEN / GROUP BY / alias), and the `timeline` union table
// (kinds, ordering, 24h default window).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeQuery, TableRegistry } from "../packages/query/src/index.js";
import { renderTimeline } from "../packages/report/src/index.js";
import { EventStore } from "../packages/store/src/index.js";
import {
	registerDevTables,
	setScopeCwd,
	timelineTable,
} from "../packages/tables-dev/src/index.js";
import {
	editsTable,
	registerRecorderTables,
} from "../packages/tables-recorder/src/index.js";
import {
	CDP_CAPABILITIES,
	type DebugExecutor,
	type DebuggerState,
} from "../packages/types/src/index.js";
import { createState } from "./helpers.js";

function storeExecutor(
	store: EventStore | null,
	state?: DebuggerState,
): DebugExecutor {
	return {
		send: async () => ({}),
		getState: () => state ?? createState(),
		getStore: () => store,
		protocol: "cdp",
		capabilities: CDP_CAPABILITIES,
	};
}

describe("edits table", () => {
	let store: EventStore | null = null;
	afterEach(() => {
		store?.close();
		store = null;
	});

	it("insertEdit rows map to columns", async () => {
		store = new EventStore(":memory:");
		store.insertEdit({
			ts: 1000,
			path: "src/App.tsx",
			epochId: 7,
			sessionId: "recorder",
		});
		const result = await editsTable.fetch(null, storeExecutor(store));
		expect(result.columns).toEqual([
			"id",
			"ts",
			"path",
			"epoch_id",
			"session_id",
		]);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0][1]).toBe(1000);
		expect(result.rows[0][2]).toBe("src/App.tsx");
		expect(result.rows[0][3]).toBe(7);
		expect(result.rows[0][4]).toBe("recorder");
	});

	it("supports WHERE session_id filtering through the engine", async () => {
		store = new EventStore(":memory:");
		store.insertEdit({ path: "a.ts", sessionId: "recorder" });
		store.insertEdit({ path: "b.ts", sessionId: "other" });
		const registry = new TableRegistry();
		registerRecorderTables(registry);
		const result = await executeQuery(
			"SELECT path FROM edits WHERE session_id = 'recorder'",
			storeExecutor(store),
			registry,
		);
		expect(result.rows).toEqual([["a.ts"]]);
	});

	// The 50ms per-path debounce lives in the daemon fs-watch handler; here we
	// assert the store faithfully persists whatever the handler decides to
	// insert (one row per accepted event), preserving epoch tagging.
	it("persists one row per insert with null epoch when unset", async () => {
		store = new EventStore(":memory:");
		store.insertEdit({ path: "x.ts", sessionId: "recorder" });
		const rows = store.query("SELECT epoch_id FROM edits");
		expect(rows).toHaveLength(1);
		expect(rows[0].epoch_id).toBeNull();
	});
});

describe("SQL materialization", () => {
	let store: EventStore | null = null;
	afterEach(() => {
		store?.close();
		store = null;
	});

	function seed(): { registry: TableRegistry; exec: DebugExecutor } {
		store = new EventStore(":memory:");
		store.insertCapture({
			ts: 1000,
			sessionId: "recorder",
			url: "http://a",
			hash: "h1",
			pngPath: "/tmp/a.png",
		});
		store.insertCapture({
			ts: 2000,
			sessionId: "recorder",
			url: "http://b",
			hash: "h2",
			pngPath: "/tmp/b.png",
		});
		store.insertEpoch({ ts: 1500, sessionId: "recorder", name: "m1" });
		store.insertEdit({ ts: 1400, path: "src/App.tsx", sessionId: "recorder" });
		const registry = new TableRegistry();
		registerRecorderTables(registry);
		return { registry, exec: storeExecutor(store) };
	}

	it("JOINs two vtables on a ts window", async () => {
		const { registry, exec } = seed();
		const result = await executeQuery(
			`SELECT edits.path, captures.url
			 FROM edits JOIN captures
			 ON captures.ts BETWEEN edits.ts AND edits.ts + 1000
			 ORDER BY captures.ts`,
			exec,
			registry,
		);
		expect(result.columns).toEqual(["path", "url"]);
		// edit@1400 windows to capture@2000 (1400..2400), not capture@1000.
		expect(result.rows).toEqual([["src/App.tsx", "http://b"]]);
	});

	it("supports BETWEEN on a single table", async () => {
		const { registry, exec } = seed();
		const result = await executeQuery(
			"SELECT url FROM captures WHERE ts BETWEEN 1500 AND 2500",
			exec,
			registry,
		);
		expect(result.rows).toEqual([["http://b"]]);
	});

	it("supports GROUP BY with an aggregate and alias", async () => {
		const { registry, exec } = seed();
		const result = await executeQuery(
			"SELECT session_id, COUNT(*) AS n FROM captures GROUP BY session_id",
			exec,
			registry,
		);
		expect(result.columns).toEqual(["session_id", "n"]);
		expect(result.rows).toEqual([["recorder", 2]]);
	});

	it("supports table aliases and dotted columns", async () => {
		const { registry, exec } = seed();
		const result = await executeQuery(
			"SELECT c.url AS u FROM captures c ORDER BY c.ts DESC",
			exec,
			registry,
		);
		expect(result.columns).toEqual(["u"]);
		expect(result.rows).toEqual([["http://b"], ["http://a"]]);
	});

	it("propagates node:sqlite errors verbatim (unknown column)", async () => {
		const { registry, exec } = seed();
		await expect(
			executeQuery(
				"SELECT nope FROM captures c JOIN epochs e ON e.ts = c.ts",
				exec,
				registry,
			),
		).rejects.toThrow(/nope/);
	});
});

describe("timeline HTML chips", () => {
	it("interleaves commit and prompt chips between frames by ts", () => {
		const html = renderTimeline({
			frames: [
				{ ts: 1000, url: "http://a", thumbPng: Buffer.from([1]), id: 1 },
				{ ts: 3000, url: "http://b", thumbPng: Buffer.from([1]), id: 2 },
			],
			commits: [{ ts: 2000, shortHash: "abc1234", summary: "fix the bug" }],
			prompts: [{ ts: 2500, text: "add coupon field" }],
		});
		expect(html).toContain("marker commit");
		expect(html).toContain("abc1234");
		expect(html).toContain("fix the bug");
		expect(html).toContain("marker prompt");
		expect(html).toContain("add coupon field");
		// commit chip sits between frame 0 (capture:1) and frame 1 (capture:2)
		const iA = html.indexOf("capture:1");
		const iCommit = html.indexOf("abc1234");
		const iB = html.indexOf("capture:2");
		expect(iA).toBeLessThan(iCommit);
		expect(iCommit).toBeLessThan(iB);
	});
});

describe("timeline union table", () => {
	let store: EventStore | null = null;
	let claudeDir = "";
	let scopeDir = "";

	afterEach(() => {
		store?.close();
		store = null;
		setScopeCwd(null);
		Reflect.deleteProperty(process.env, "DBG_CLAUDE_DIR");
		for (const d of [claudeDir, scopeDir]) {
			if (d) fs.rmSync(d, { recursive: true, force: true });
		}
		claudeDir = "";
		scopeDir = "";
	});

	function isolateDevSources(): void {
		// Point commits at a non-git dir and agent history at an empty dir so
		// the union only reflects the seeded store + session state.
		claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-u-claude-"));
		scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-u-scope-"));
		process.env.DBG_CLAUDE_DIR = claudeDir;
		setScopeCwd(scopeDir);
	}

	function seed(now: number): DebugExecutor {
		store = new EventStore(":memory:");
		store.insertCapture({
			ts: now - 1000,
			sessionId: "recorder",
			url: "http://a",
			hash: "h",
			pngPath: "/tmp/a.png",
		});
		store.insertEpoch({ ts: now - 900, sessionId: "recorder", name: "mark-1" });
		store.insertEpoch({ ts: now - 800, sessionId: "recorder" }); // auto → 'epoch'
		store.insertEdit({
			ts: now - 700,
			path: "src/App.tsx",
			sessionId: "recorder",
		});
		store.insertDiff({
			ts: now - 600,
			name: "d1",
			baselineCaptureId: 1,
			afterCaptureId: 2,
			diffPercent: 1,
			diffPixels: 10,
			reportPath: "/tmp/r.html",
		});
		// An old capture outside the 24h default window.
		store.insertCapture({
			ts: now - 2 * 24 * 60 * 60 * 1000,
			sessionId: "recorder",
			url: "http://old",
			hash: "old",
			pngPath: "/tmp/old.png",
		});
		const state = createState({
			console: [
				{ id: 1, type: "error", text: "boom", ts: now - 500, stack: "" },
			],
			exceptions: [
				{
					id: 2,
					text: "TypeError: x",
					type: "TypeError",
					file: "src/App.tsx",
					line: 5,
					ts: now - 400,
					uncaught: true,
				},
			],
		});
		return storeExecutor(store, state);
	}

	it("unions kinds in ascending ts order within the 24h window", async () => {
		isolateDevSources();
		const now = Date.now();
		const exec = seed(now);
		const result = await timelineTable.fetch(null, exec);
		const kindIdx = result.columns.indexOf("kind");
		const tsIdx = result.columns.indexOf("ts");
		const kinds = result.rows.map((r) => r[kindIdx]);
		expect(new Set(kinds)).toEqual(
			new Set([
				"capture",
				"mark",
				"epoch",
				"edit",
				"diff",
				"error",
				"exception",
			]),
		);
		// ascending ts
		const tss = result.rows.map((r) => Number(r[tsIdx]));
		expect(tss).toEqual([...tss].sort((a, b) => a - b));
		// old capture excluded by default
		const labels = result.rows.map((r) => r[result.columns.indexOf("label")]);
		expect(labels).not.toContain("http://old");
	});

	it("includes history beyond 24h when WHERE constrains ts", async () => {
		isolateDevSources();
		const now = Date.now();
		const exec = seed(now);
		const registry = new TableRegistry();
		registerDevTables(registry);
		registry.register(timelineTable);
		registerRecorderTables(registry);
		const result = await executeQuery(
			"SELECT label FROM timeline WHERE ts > 0 AND kind = 'capture' ORDER BY ts",
			exec,
			registry,
		);
		const labels = result.rows.map((r) => r[0]);
		expect(labels).toContain("http://old");
		expect(labels).toContain("http://a");
	});
});
