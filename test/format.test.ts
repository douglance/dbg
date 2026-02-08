import { describe, expect, it } from "vitest";
import {
	formatBreakpointList,
	formatBreakpointSet,
	formatFlowStatus,
	formatJson,
	formatSource,
	formatStatus,
	formatTsv,
} from "../src/format.js";

describe("formatTsv", () => {
	it("produces header and rows", () => {
		const result = formatTsv(
			["name", "value"],
			[
				["x", 10],
				["y", 20],
			],
		);
		expect(result).toBe("name\tvalue\nx\t10\ny\t20");
	});

	it("returns header only when rows are empty", () => {
		const result = formatTsv(["a", "b", "c"], []);
		expect(result).toBe("a\tb\tc");
	});

	it("handles null and undefined cells", () => {
		const result = formatTsv(["col"], [[null], [undefined]]);
		expect(result).toBe("col\n\n");
	});

	it("handles boolean cells", () => {
		const result = formatTsv(["flag"], [[true], [false]]);
		expect(result).toBe("flag\ntrue\nfalse");
	});

	it("JSON-stringifies object cells", () => {
		const result = formatTsv(["data"], [[{ a: 1 }]]);
		expect(result).toBe('data\n{"a":1}');
	});

	it("handles special characters in strings", () => {
		const result = formatTsv(["text"], [["hello\tworld"], ["line\nnewline"]]);
		// String values are passed through as-is
		expect(result).toContain("hello\tworld");
	});
});

describe("formatJson", () => {
	it("converts columns and rows to array of objects", () => {
		const result = formatJson(
			["name", "value"],
			[
				["x", 10],
				["y", 20],
			],
		);
		expect(JSON.parse(result)).toEqual([
			{ name: "x", value: 10 },
			{ name: "y", value: 20 },
		]);
	});

	it("returns empty array for no rows", () => {
		const result = formatJson(["a", "b"], []);
		expect(JSON.parse(result)).toEqual([]);
	});

	it("maps columns to row values by index", () => {
		const result = formatJson(["id", "type", "count"], [["abc", "number", 5]]);
		const parsed = JSON.parse(result);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toEqual({ id: "abc", type: "number", count: 5 });
	});
});

describe("formatFlowStatus", () => {
	it("returns 'running' for running status", () => {
		expect(formatFlowStatus("running")).toBe("running");
	});

	it("returns paused with file, line, and function", () => {
		const result = formatFlowStatus("paused", "app.ts", 42, "main");
		expect(result).toBe("paused\tapp.ts\t42\tmain");
	});

	it("returns paused with empty fields when not provided", () => {
		const result = formatFlowStatus("paused");
		expect(result).toBe("paused\t\t\t");
	});

	it("returns paused with partial fields", () => {
		const result = formatFlowStatus("paused", "index.js", 10);
		expect(result).toBe("paused\tindex.js\t10\t");
	});
});

describe("formatBreakpointSet", () => {
	it("formats id, file, line as TSV", () => {
		const result = formatBreakpointSet("bp-1", "app.ts", 42);
		expect(result).toBe("bp-1\tapp.ts\t42");
	});
});

describe("formatBreakpointList", () => {
	it("formats header and breakpoint rows", () => {
		const result = formatBreakpointList([
			{ id: "bp-1", file: "app.ts", line: 10, condition: "", hits: 0 },
			{ id: "bp-2", file: "lib.ts", line: 20, condition: "x > 5", hits: 3 },
		]);
		const lines = result.split("\n");
		expect(lines[0]).toBe("id\tfile\tline\tcondition\thits");
		expect(lines[1]).toBe("bp-1\tapp.ts\t10\t\t0");
		expect(lines[2]).toBe("bp-2\tlib.ts\t20\tx > 5\t3");
	});

	it("returns header only when no breakpoints", () => {
		const result = formatBreakpointList([]);
		expect(result).toBe("id\tfile\tline\tcondition\thits");
	});
});

describe("formatSource", () => {
	it("formats lines with line numbers", () => {
		const result = formatSource([
			{ line: 1, text: "const x = 1;" },
			{ line: 2, text: "const y = 2;" },
		]);
		expect(result).toBe("1\tconst x = 1;\n2\tconst y = 2;");
	});

	it("marks the current line with >", () => {
		const result = formatSource(
			[
				{ line: 5, text: "a" },
				{ line: 6, text: "b" },
				{ line: 7, text: "c" },
			],
			6,
		);
		const lines = result.split("\n");
		expect(lines[0]).toBe("5\ta");
		expect(lines[1]).toBe("6>\tb");
		expect(lines[2]).toBe("7\tc");
	});

	it("handles no current line", () => {
		const result = formatSource([{ line: 1, text: "hello" }]);
		expect(result).toBe("1\thello");
	});

	it("handles empty lines array", () => {
		const result = formatSource([]);
		expect(result).toBe("");
	});
});

describe("formatStatus", () => {
	it("shows disconnected", () => {
		const result = formatStatus(false, false);
		expect(result).toBe("disconnected");
	});

	it("shows connected and running", () => {
		const result = formatStatus(true, false);
		expect(result).toBe("connected\trunning");
	});

	it("shows connected and paused with location", () => {
		const result = formatStatus(true, true, "app.ts", 42, "main");
		expect(result).toBe("connected\tpaused\tapp.ts:42\tmain");
	});

	it("shows paused without function name", () => {
		const result = formatStatus(true, true, "app.ts", 10);
		expect(result).toBe("connected\tpaused\tapp.ts:10");
	});

	it("includes pid when provided", () => {
		const result = formatStatus(
			true,
			false,
			undefined,
			undefined,
			undefined,
			12345,
		);
		expect(result).toBe("connected\trunning\tpid=12345");
	});

	it("shows disconnected with pid", () => {
		const result = formatStatus(
			false,
			false,
			undefined,
			undefined,
			undefined,
			9999,
		);
		expect(result).toBe("disconnected\tpid=9999");
	});

	it("shows full status with pid", () => {
		const result = formatStatus(true, true, "app.ts", 5, "init", 42);
		expect(result).toBe("connected\tpaused\tapp.ts:5\tinit\tpid=42");
	});

	it("omits pid when null", () => {
		const result = formatStatus(true, true, "app.ts", 5, "init", null);
		expect(result).toBe("connected\tpaused\tapp.ts:5\tinit");
	});
});
