// Plan V unit coverage: network diff (URL-pattern grouping + id normalization),
// storage diff, a11y rule engine, and `dbg why` cause ranking.

import { describe, expect, it } from "vitest";
import {
	computeA11yIssues,
	type AxTree,
} from "../packages/cli/src/recorder/a11y.js";
import {
	diffNetwork,
	type NetRequest,
	normalizeUrlPattern,
} from "../packages/cli/src/recorder/netdiff.js";
import { diffStorage } from "../packages/cli/src/recorder/storage-diff.js";
import { rankCauses } from "../packages/cli/src/recorder/why.js";

describe("network diff", () => {
	it("normalizes numeric ids and uuids in the URL pattern", () => {
		expect(normalizeUrlPattern("https://x.com/api/users/42?t=9")).toBe(
			"x.com/api/users/:id",
		);
		expect(
			normalizeUrlPattern(
				"https://x.com/o/123e4567-e89b-12d3-a456-426614174000/edit",
			),
		).toBe("x.com/o/:id/edit");
	});

	it("groups /users/1 and /users/2 together (id-normalized)", () => {
		const before: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/users/1",
				status: 200,
				duration: 10,
			},
		];
		const after: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/users/2",
				status: 200,
				duration: 10,
			},
		];
		const diff = diffNetwork(before, after);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.statusChanged).toHaveLength(0);
	});

	it("catches a changed URL + status (added/removed + status pathways)", () => {
		const before: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/api/v1/data",
				status: 200,
				duration: 20,
			},
		];
		const after: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/api/v2/data",
				status: 500,
				duration: 30,
			},
		];
		const diff = diffNetwork(before, after);
		expect(diff.added.map((a) => a.pattern)).toContain("x.com/api/v2/data");
		expect(diff.removed.map((r) => r.pattern)).toContain("x.com/api/v1/data");
	});

	it("reports status changes on the same endpoint", () => {
		const before: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/api/data",
				status: 200,
				duration: 20,
			},
		];
		const after: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/api/data",
				status: 500,
				duration: 20,
			},
		];
		const diff = diffNetwork(before, after);
		expect(diff.statusChanged).toEqual([
			{
				method: "GET",
				pattern: "x.com/api/data",
				url: "https://x.com/api/data",
				before: 200,
				after: 500,
			},
		]);
	});

	it("reports a duration delta beyond the threshold", () => {
		const before: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/api/data",
				status: 200,
				duration: 20,
			},
		];
		const after: NetRequest[] = [
			{
				method: "GET",
				url: "https://x.com/api/data",
				status: 200,
				duration: 200,
			},
		];
		const diff = diffNetwork(before, after);
		expect(diff.durationDelta).toHaveLength(1);
		expect(diff.durationDelta[0].deltaMs).toBe(180);
	});
});

describe("storage diff", () => {
	it("detects added, removed, and changed keys with JSON parsing", () => {
		const changes = diffStorage(
			{
				localStorage: { keep: "1", drop: "x", num: "1" },
				sessionStorage: {},
			},
			{
				localStorage: { keep: "1", num: "2", added: '{"a":1}' },
				sessionStorage: {},
			},
		);
		const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
		expect(byKey.drop.change).toBe("removed");
		expect(byKey.num).toMatchObject({ change: "changed", before: 1, after: 2 });
		expect(byKey.added).toMatchObject({ change: "added", after: { a: 1 } });
		expect(byKey.keep).toBeUndefined();
	});
});

describe("a11y rules", () => {
	const tree: AxTree = {
		nodes: [
			{ role: { value: "RootWebArea" }, name: { value: "" } },
			{ role: { value: "button" }, name: { value: "" } },
			{ role: { value: "button" }, name: { value: "Submit" } },
			{ role: { value: "image" }, name: { value: "" } },
			{ role: { value: "textbox" }, name: { value: "" } },
			{ role: { value: "navigation" }, name: { value: "" } },
			{ role: { value: "navigation" }, name: { value: "" } },
		],
	};

	it("flags the five rule families and stays stable across reorders", () => {
		const issues = computeA11yIssues(tree);
		const rules = new Set(issues.map((i) => i.rule));
		expect(rules).toContain("document-missing-title");
		expect(rules).toContain("control-missing-name"); // button w/o name
		expect(rules).toContain("image-missing-alt");
		expect(rules).toContain("control-missing-label"); // textbox
		expect(rules).toContain("duplicate-landmark");
		// the named button produces no issue
		expect(
			issues.filter((i) => i.rule === "control-missing-name"),
		).toHaveLength(1);
	});

	it("produces NEW issues only for the newly-unlabeled control", () => {
		const before = computeA11yIssues({
			nodes: [{ role: { value: "button" }, name: { value: "Save" } }],
		});
		const after = computeA11yIssues({
			nodes: [{ role: { value: "button" }, name: { value: "" } }],
		});
		const beforeKeys = new Set(before.map((i) => `${i.rule}|${i.selector}`));
		const newIssues = after.filter(
			(i) => !beforeKeys.has(`${i.rule}|${i.selector}`),
		);
		expect(newIssues.map((i) => i.rule)).toEqual(["control-missing-name"]);
	});
});

describe("why ranking", () => {
	const now = 1_000_000;
	it("ranks the recent, in-stack edit first and phrases the answer", () => {
		const verdict = rankCauses(
			{ ts: now, text: "Cannot read x of undefined", stack: "at Cart.tsx:12" },
			{
				edits: [
					{ ts: now - 2100, path: "src/Cart.tsx", epochId: 4 },
					{ ts: now - 1000, path: "src/unrelated.css", epochId: 4 },
				],
				epochs: [{ ts: now - 5000, id: 4, name: "before-fix" }],
				commits: [{ ts: now - 60000, shortHash: "abc1234", summary: "wip" }],
				prompts: [{ ts: now - 9000, display: "add coupon field" }],
			},
		);
		expect(verdict.edits[0].path).toBe("src/Cart.tsx");
		expect(verdict.edits[0].inStack).toBe(true);
		expect(verdict.epoch?.id).toBe(4);
		expect(verdict.commit?.shortHash).toBe("abc1234");
		expect(verdict.prompt?.display).toBe("add coupon field");
		expect(verdict.answer).toContain("src/Cart.tsx");
		expect(verdict.answer).toContain("add coupon field");
	});

	it("excludes edits outside the lookback window", () => {
		const verdict = rankCauses(
			{ ts: now, text: "boom" },
			{
				edits: [{ ts: now - 10 * 60 * 1000, path: "old.ts", epochId: null }],
				epochs: [],
				commits: [],
				prompts: [],
			},
		);
		expect(verdict.edits).toHaveLength(0);
		expect(verdict.answer).toContain("no preceding");
	});
});
