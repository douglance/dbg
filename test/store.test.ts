import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../packages/store/src/index.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("EventStore", () => {
	let store: EventStore | null = null;
	let dbPath: string | null = null;

	afterEach(() => {
		store?.close();
		store = null;
		if (dbPath && fs.existsSync(dbPath)) {
			fs.unlinkSync(dbPath);
		}
		dbPath = null;
	});

	it("creates schema and stores events", () => {
		store = new EventStore(":memory:");
		store.record({
			source: "daemon",
			category: "lifecycle",
			method: "daemon.start",
			data: { pid: 123 },
		});
		store.flush();

		const rows = store.query(
			"SELECT source, category, method, data FROM events ORDER BY id",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].source).toBe("daemon");
		expect(rows[0].category).toBe("lifecycle");
		expect(rows[0].method).toBe("daemon.start");
		expect(rows[0].data).toBe('{"pid":123}');
	});

	it("flushes buffered writes on interval", async () => {
		dbPath = path.join(os.tmpdir(), `dbg-events-${randomUUID()}.db`);
		store = new EventStore(dbPath);
		store.record({
			source: "cdp_send",
			category: "cdp",
			method: "Runtime.evaluate",
			data: { expression: "1+1" },
		});

		await sleep(200);

		const reader = new DatabaseSync(dbPath);
		const row = reader
			.prepare("SELECT COUNT(*) AS count FROM events")
			.get() as {
			count: number;
		};
		reader.close();

		expect(row.count).toBeGreaterThan(0);
	});

	it("stores session IDs and supports json_extract", () => {
		store = new EventStore(":memory:");
		store.record(
			{
				source: "cdp_recv",
				category: "cdp",
				method: "Runtime.evaluate",
				data: { latencyMs: 17, error: null },
				sessionId: "session-1",
			},
			true,
		);

		const rows = store.query(
			"SELECT session_id, json_extract(data, '$.latencyMs') AS latency FROM events",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].session_id).toBe("session-1");
		expect(rows[0].latency).toBe(17);
	});
});
