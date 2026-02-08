import { describe, it, expect } from "vitest";
import { parseQuery } from "../src/query/parser.js";

describe("parser", () => {
	it("parses SELECT * FROM table", () => {
		const q = parseQuery("SELECT * FROM frames");
		expect(q.columns).toBe("*");
		expect(q.table).toBe("frames");
		expect(q.where).toBeNull();
	});

	it("parses specific columns", () => {
		const q = parseQuery("SELECT name, value FROM vars");
		expect(q.columns).toEqual(["name", "value"]);
		expect(q.table).toBe("vars");
	});

	it("parses WHERE with comparison", () => {
		const q = parseQuery("SELECT * FROM vars WHERE frame_id = 0");
		expect(q.where).toEqual({
			type: "comparison",
			column: "frame_id",
			op: "=",
			value: 0,
		});
	});

	it("parses WHERE with string value", () => {
		const q = parseQuery("SELECT * FROM scripts WHERE file = 'app.ts'");
		expect(q.where).toEqual({
			type: "comparison",
			column: "file",
			op: "=",
			value: "app.ts",
		});
	});

	it("parses WHERE with LIKE", () => {
		const q = parseQuery("SELECT * FROM scripts WHERE file LIKE '%cart%'");
		expect(q.where).toEqual({
			type: "comparison",
			column: "file",
			op: "LIKE",
			value: "%cart%",
		});
	});

	it("parses WHERE with AND", () => {
		const q = parseQuery(
			"SELECT * FROM source WHERE file = 'a.ts' AND line >= 10",
		);
		expect(q.where).not.toBeNull();
		if (!q.where) throw new Error("Expected WHERE clause");
		expect(q.where.type).toBe("and");
	});

	it("parses WHERE with OR", () => {
		const q = parseQuery(
			"SELECT * FROM vars WHERE name = 'x' OR name = 'y'",
		);
		expect(q.where).not.toBeNull();
		if (!q.where) throw new Error("Expected WHERE clause");
		expect(q.where.type).toBe("or");
	});

	it("parses ORDER BY", () => {
		const q = parseQuery("SELECT * FROM frames ORDER BY line DESC");
		expect(q.orderBy).toEqual({ column: "line", direction: "DESC" });
	});

	it("parses LIMIT", () => {
		const q = parseQuery("SELECT * FROM console LIMIT 10");
		expect(q.limit).toBe(10);
	});

	it("parses complex query", () => {
		const q = parseQuery(
			"SELECT name, value FROM vars WHERE frame_id = 0 AND name != '__proto__' ORDER BY name ASC LIMIT 20",
		);
		expect(q.columns).toEqual(["name", "value"]);
		expect(q.table).toBe("vars");
		expect(q.where).not.toBeNull();
		if (!q.where) throw new Error("Expected WHERE clause");
		expect(q.where.type).toBe("and");
		expect(q.orderBy).toEqual({ column: "name", direction: "ASC" });
		expect(q.limit).toBe(20);
	});

	it("is case-insensitive for keywords", () => {
		const q = parseQuery("select * from frames where id = 0");
		expect(q.table).toBe("frames");
		expect(q.where).not.toBeNull();
	});

	it("handles parenthesized conditions", () => {
		const q = parseQuery(
			"SELECT * FROM vars WHERE (name = 'x' OR name = 'y') AND frame_id = 0",
		);
		expect(q.where).not.toBeNull();
		if (!q.where) throw new Error("Expected WHERE clause");
		expect(q.where.type).toBe("and");
	});
});
