import { afterEach, describe, expect, it } from "vitest";
import {
	executeQuery,
	parseQuery,
	TableRegistry,
} from "../packages/query/src/index.js";
import { EventStore } from "../packages/store/src/index.js";
import { registerBrowserTables } from "../packages/tables-browser/src/index.js";
import { registerCoreTables } from "../packages/tables-core/src/index.js";
import {
	capturesTable,
	epochsTable,
	registerRecorderTables,
} from "../packages/tables-recorder/src/index.js";
import {
	CDP_CAPABILITIES,
	type DebugExecutor,
} from "../packages/types/src/index.js";
import { createState } from "./helpers.js";

function createStoreExecutor(store: EventStore | null): DebugExecutor {
	return {
		send: async () => ({}),
		getState: () => createState(),
		getStore: () => store,
		protocol: "cdp",
		capabilities: CDP_CAPABILITIES,
	};
}

describe("recorder virtual tables", () => {
	let store: EventStore | null = null;

	afterEach(() => {
		store?.close();
		store = null;
	});

	it("captures maps store rows to columns", async () => {
		store = new EventStore(":memory:");
		store.insertCapture({
			ts: 1000,
			sessionId: "recorder",
			url: "http://localhost:3000/",
			scrollY: 10,
			dpr: 2,
			hash: "abc",
			pngPath: "/tmp/1000-abc.png",
		});

		const result = await capturesTable.fetch(null, createStoreExecutor(store));
		expect(result.columns).toEqual([
			"id",
			"ts",
			"session_id",
			"url",
			"scroll_y",
			"dpr",
			"hash",
			"png_path",
			"changed_files",
			"hmr_modules",
			"epoch_id",
			"snapshot_path",
			"ax_path",
			"tier",
		]);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0][2]).toBe("recorder");
		expect(result.rows[0][3]).toBe("http://localhost:3000/");
		expect(result.rows[0][7]).toBe("/tmp/1000-abc.png");
	});

	it("epochs maps store rows to columns", async () => {
		store = new EventStore(":memory:");
		store.insertEpoch({ ts: 5, sessionId: "recorder", name: "m1" });

		const result = await epochsTable.fetch(null, createStoreExecutor(store));
		expect(result.columns).toEqual(["id", "ts", "session_id", "name", "auto"]);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0][3]).toBe("m1");
		expect(result.rows[0][4]).toBe(0);
	});

	it("returns empty rows without a store", async () => {
		const result = await capturesTable.fetch(null, createStoreExecutor(null));
		expect(result.rows).toEqual([]);
	});

	it("supports WHERE session_id filtering through the engine", async () => {
		store = new EventStore(":memory:");
		store.insertCapture({
			sessionId: "recorder",
			url: "a",
			hash: "h1",
			pngPath: "/tmp/a.png",
		});
		store.insertCapture({
			sessionId: "other",
			url: "b",
			hash: "h2",
			pngPath: "/tmp/b.png",
		});

		const registry = new TableRegistry();
		registerRecorderTables(registry);
		const result = await executeQuery(
			"SELECT url FROM captures WHERE session_id = 'recorder'",
			createStoreExecutor(store),
			registry,
		);
		expect(result.rows).toEqual([["a"]]);
	});

	it("does not shadow the legacy stack-frames table", async () => {
		const registry = new TableRegistry();
		registerCoreTables(registry);
		registerRecorderTables(registry);
		const framesTable = registry.getTable("frames", "cdp");
		expect(framesTable?.columns).toContain("function");
	});
});

describe("COUNT(*) queries", () => {
	it("parses SELECT COUNT(*) case-insensitively", () => {
		expect(parseQuery("SELECT COUNT(*) FROM captures").count).toBe(true);
		expect(parseQuery("select count(*) from captures").count).toBe(true);
		expect(parseQuery("SELECT * FROM captures").count).toBeUndefined();
	});

	it("dbg q 'SELECT COUNT(*) FROM captures' returns recorder rows (daemon registry shape)", async () => {
		const registry = new TableRegistry();
		registerCoreTables(registry);
		registerBrowserTables(registry);
		registerRecorderTables(registry);

		const localStore = new EventStore(":memory:");
		try {
			const executor = createStoreExecutor(localStore);
			const empty = await executeQuery(
				"SELECT COUNT(*) FROM captures",
				executor,
				registry,
			);
			expect(empty.columns).toEqual(["count"]);
			expect(empty.rows).toEqual([[0]]);

			localStore.insertCapture({
				sessionId: "recorder",
				url: "a",
				hash: "h",
				pngPath: "/tmp/a.png",
			});
			const captures = await executeQuery(
				"SELECT COUNT(*) FROM captures",
				executor,
				registry,
			);
			expect(captures.rows).toEqual([[1]]);

			const epochs = await executeQuery(
				"SELECT COUNT(*) FROM epochs",
				executor,
				registry,
			);
			expect(epochs.rows).toEqual([[0]]);
		} finally {
			localStore.close();
		}
	});

	it("counts filtered rows", async () => {
		const localStore = new EventStore(":memory:");
		try {
			localStore.insertEpoch({ sessionId: "recorder", name: "a" });
			localStore.insertEpoch({ sessionId: "other", name: "b" });
			const registry = new TableRegistry();
			registerRecorderTables(registry);
			const result = await executeQuery(
				"SELECT COUNT(*) FROM epochs WHERE session_id = 'recorder'",
				createStoreExecutor(localStore),
				registry,
			);
			expect(result.rows).toEqual([[1]]);
		} finally {
			localStore.close();
		}
	});
});
