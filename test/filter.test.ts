import { describe, it, expect } from "vitest";
import { filterRows, orderRows, limitRows } from "../src/query/filter.js";

describe("filter", () => {
	const columns = ["name", "type", "value"];
	const rows: unknown[][] = [
		["x", "number", "10"],
		["y", "string", "hello"],
		["z", "number", "5"],
		["w", "boolean", "true"],
	];

	it("filters with = comparison", () => {
		const result = filterRows(columns, rows, {
			type: "comparison",
			column: "name",
			op: "=",
			value: "x",
		});
		expect(result).toEqual([["x", "number", "10"]]);
	});

	it("filters with != comparison", () => {
		const result = filterRows(columns, rows, {
			type: "comparison",
			column: "type",
			op: "!=",
			value: "number",
		});
		expect(result).toHaveLength(2);
	});

	it("filters with numeric comparison", () => {
		const result = filterRows(columns, rows, {
			type: "comparison",
			column: "value",
			op: ">",
			value: 7,
		});
		expect(result).toEqual([["x", "number", "10"]]);
	});

	it("filters with LIKE", () => {
		const result = filterRows(columns, rows, {
			type: "comparison",
			column: "name",
			op: "LIKE",
			value: "%z%",
		});
		expect(result).toHaveLength(1);
	});

	it("filters with AND", () => {
		const result = filterRows(columns, rows, {
			type: "and",
			left: {
				type: "comparison",
				column: "type",
				op: "=",
				value: "number",
			},
			right: {
				type: "comparison",
				column: "value",
				op: ">",
				value: 7,
			},
		});
		expect(result).toEqual([["x", "number", "10"]]);
	});

	it("filters with OR", () => {
		const result = filterRows(columns, rows, {
			type: "or",
			left: {
				type: "comparison",
				column: "name",
				op: "=",
				value: "x",
			},
			right: {
				type: "comparison",
				column: "name",
				op: "=",
				value: "z",
			},
		});
		expect(result).toHaveLength(2);
	});

	it("orders ascending", () => {
		const result = orderRows(columns, rows, {
			column: "name",
			direction: "ASC",
		});
		expect(result[0][0]).toBe("w");
		expect(result[3][0]).toBe("z");
	});

	it("orders descending", () => {
		const result = orderRows(columns, rows, {
			column: "name",
			direction: "DESC",
		});
		expect(result[0][0]).toBe("z");
		expect(result[3][0]).toBe("w");
	});

	it("limits rows", () => {
		const result = limitRows(rows, 2);
		expect(result).toHaveLength(2);
	});

	it("returns all when no filter", () => {
		const result = filterRows(columns, rows, null);
		expect(result).toHaveLength(4);
	});
});
