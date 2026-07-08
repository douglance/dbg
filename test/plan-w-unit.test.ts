// Plan W unit coverage: suffix→urlRegex, logpoint condition, sentinel parsing.

import { describe, expect, it } from "vitest";
import {
	buildTapCondition,
	parseTapSentinel,
	suffixUrlRegex,
	TAP_SENTINEL_PREFIX,
} from "../packages/cli/src/recorder/taps.js";

describe("suffixUrlRegex", () => {
	it("escapes dots and strips a leading ./ or /", () => {
		expect(suffixUrlRegex("src/Foo.tsx")).toBe("src/Foo\\.tsx");
		expect(suffixUrlRegex("./src/Foo.tsx")).toBe("src/Foo\\.tsx");
		expect(suffixUrlRegex("/src/Foo.tsx")).toBe("src/Foo\\.tsx");
	});

	it("produces a regex that matches a Vite URL suffix incl. a query", () => {
		const re = new RegExp(suffixUrlRegex("src/Foo.tsx"));
		expect(re.test("http://localhost:3000/src/Foo.tsx")).toBe(true);
		expect(re.test("http://localhost:3000/src/Foo.tsx?t=123")).toBe(true);
		expect(re.test("http://localhost:3000/src/FooXtsx")).toBe(false);
	});
});

describe("buildTapCondition", () => {
	it("is a void console.log with the tap sentinel and a guarded expr", () => {
		const cond = buildTapCondition(7, "user.id");
		expect(cond.startsWith("void console.log(")).toBe(true);
		expect(cond).toContain(`${TAP_SENTINEL_PREFIX}7`);
		expect(cond).toContain("(user.id)");
		expect(cond).toContain("tap-expr-error:");
	});

	it("evaluates to undefined (never pauses) and logs the value", () => {
		const logs: unknown[][] = [];
		const console = { log: (...a: unknown[]) => logs.push(a) };
		const user = { id: 42 };
		// Emulate the debugger evaluating the condition in scope.
		const result = new Function(
			"console",
			"user",
			`return (${buildTapCondition(7, "user.id")});`,
		)(console, user);
		expect(result).toBeUndefined(); // falsy → breakpoint does not pause
		expect(logs).toEqual([["__dbg_tap:7", 42]]);
	});

	it("captures a throwing expression as a tap-expr-error string", () => {
		const logs: unknown[][] = [];
		const console = { log: (...a: unknown[]) => logs.push(a) };
		new Function("console", `return (${buildTapCondition(3, "nope.nested")});`)(
			console,
		);
		expect(String(logs[0][1])).toContain("tap-expr-error:");
	});
});

describe("parseTapSentinel", () => {
	it("extracts the tap id and stringified value", () => {
		expect(
			parseTapSentinel([
				{ type: "string", value: "__dbg_tap:5" },
				{ type: "number", value: 42 },
			]),
		).toEqual({ tapId: 5, value: "42" });
	});

	it("stringifies object values via description/JSON", () => {
		expect(
			parseTapSentinel([
				{ type: "string", value: "__dbg_tap:1" },
				{ type: "object", description: "Array(3)" },
			]),
		).toEqual({ tapId: 1, value: "Array(3)" });
	});

	it("returns null for non-tap console rows", () => {
		expect(
			parseTapSentinel([{ type: "string", value: "hello world" }]),
		).toBeNull();
		expect(parseTapSentinel([])).toBeNull();
		expect(parseTapSentinel(null)).toBeNull();
	});
});
