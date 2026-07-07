import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../packages/store/src/index.js";

describe("EventStore recorder tables", () => {
	let store: EventStore | null = null;

	afterEach(() => {
		store?.close();
		store = null;
	});

	it("round-trips a capture row", () => {
		store = new EventStore(":memory:");
		const id = store.insertCapture({
			ts: 1000,
			sessionId: "recorder",
			url: "http://localhost:3000/",
			scrollY: 42.5,
			dpr: 2,
			hash: "abc123",
			pngPath: "/tmp/.dbg/recordings/recorder/1000-abc123.png",
			changedFiles: ["src/App.tsx"],
			hmrModules: ["/src/App.tsx"],
			epochId: null,
		});
		expect(id).toBeGreaterThan(0);

		const rows = store.query("SELECT * FROM captures WHERE id = ?", [id]);
		expect(rows).toHaveLength(1);
		expect(rows[0].ts).toBe(1000);
		expect(rows[0].session_id).toBe("recorder");
		expect(rows[0].url).toBe("http://localhost:3000/");
		expect(rows[0].scroll_y).toBe(42.5);
		expect(rows[0].dpr).toBe(2);
		expect(rows[0].hash).toBe("abc123");
		expect(rows[0].png_path).toBe(
			"/tmp/.dbg/recordings/recorder/1000-abc123.png",
		);
		expect(rows[0].changed_files).toBe('["src/App.tsx"]');
		expect(rows[0].hmr_modules).toBe('["/src/App.tsx"]');
		expect(rows[0].epoch_id).toBeNull();
	});

	it("applies capture defaults (scroll 0, dpr 1, empty JSON lists)", () => {
		store = new EventStore(":memory:");
		const id = store.insertCapture({
			sessionId: "recorder",
			url: "about:blank",
			hash: "d41d8cd9",
			pngPath: "/tmp/capture.png",
		});
		const rows = store.query("SELECT * FROM captures WHERE id = ?", [id]);
		expect(rows[0].scroll_y).toBe(0);
		expect(rows[0].dpr).toBe(1);
		expect(rows[0].changed_files).toBe("[]");
		expect(rows[0].hmr_modules).toBe("[]");
		expect(rows[0].epoch_id).toBeNull();
		expect(Number(rows[0].ts)).toBeGreaterThan(0);
	});

	it("round-trips epoch rows and links captures to epochs", () => {
		store = new EventStore(":memory:");
		const epochId = store.insertEpoch({
			ts: 500,
			sessionId: "recorder",
			name: "before-refactor",
			auto: false,
		});
		const autoEpochId = store.insertEpoch({
			sessionId: "recorder",
			auto: true,
		});
		expect(autoEpochId).toBe(epochId + 1);

		const captureId = store.insertCapture({
			sessionId: "recorder",
			url: "about:blank",
			hash: "h",
			pngPath: "/tmp/c.png",
			epochId,
		});

		const epochs = store.query("SELECT * FROM epochs ORDER BY id");
		expect(epochs).toHaveLength(2);
		expect(epochs[0].name).toBe("before-refactor");
		expect(epochs[0].auto).toBe(0);
		expect(epochs[1].name).toBeNull();
		expect(epochs[1].auto).toBe(1);

		const joined = store.query(
			"SELECT c.id AS capture_id, e.name FROM captures c JOIN epochs e ON c.epoch_id = e.id",
		);
		expect(joined).toHaveLength(1);
		expect(joined[0].capture_id).toBe(captureId);
		expect(joined[0].name).toBe("before-refactor");
	});
});
