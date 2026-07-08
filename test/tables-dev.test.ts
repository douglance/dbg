// Tests for @dbg/tables-dev — git commits + Claude Code agent history
// virtual tables. Uses a temp $DBG_CLAUDE_DIR with synthetic fixtures and
// a throwaway git repo created in the test.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executeQuery, TableRegistry } from "../packages/query/src/index.js";
import {
	agentPromptsTable,
	agentSessionsTable,
	commitsTable,
	registerDevTables,
	resetSessionCache,
	sessionScanStats,
} from "../packages/tables-dev/src/index.js";
import {
	CDP_CAPABILITIES,
	type DebugExecutor,
} from "../packages/types/src/index.js";
import { createState } from "./helpers.js";

function createDevExecutor(): DebugExecutor {
	return {
		send: async () => ({}),
		getState: () => createState(),
		getStore: () => null,
		protocol: "cdp",
		capabilities: CDP_CAPABILITIES,
	};
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// Commit with an explicit author date so the two commits get distinct,
// deterministic epoch-ms `ts` values (still near "now" for the join test).
function gitCommitAt(cwd: string, epochSeconds: number, message: string): void {
	execFileSync("git", ["commit", "-q", "-m", message], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: `${epochSeconds} +0000`,
			GIT_COMMITTER_DATE: `${epochSeconds} +0000`,
		},
	});
}

// Slug convention: cwd path with '/' and '.' -> '-'
const cwdSlug = process.cwd().replace(/[/.]/g, "-");

let claudeDir: string;
let repoDir: string;
let savedClaudeDir: string | undefined;

const PROMPT_TS_NUMBER = 1700000000000;
const PROMPT_TS_STRING = "1700000060000";
const OTHER_SLUG = "-Users-someone-else-proj";

beforeAll(() => {
	savedClaudeDir = process.env.DBG_CLAUDE_DIR;
	claudeDir = mkdtempSync(join(tmpdir(), "dbg-tables-dev-claude-"));
	process.env.DBG_CLAUDE_DIR = claudeDir;

	// history.jsonl: number ts + numeric-string ts (current project), a
	// foreign-project entry, and a malformed line.
	writeFileSync(
		join(claudeDir, "history.jsonl"),
		[
			JSON.stringify({
				display: "fix the flaky test",
				timestamp: PROMPT_TS_NUMBER,
				project: cwdSlug,
			}),
			JSON.stringify({
				display: "add the dev tables",
				timestamp: PROMPT_TS_STRING,
				project: cwdSlug,
			}),
			// Newer history entries store the raw absolute path; it must be
			// normalized to the slug and land in the default (cwd) scope.
			JSON.stringify({
				display: "raw path entry",
				timestamp: PROMPT_TS_NUMBER + 120000,
				project: process.cwd(),
			}),
			JSON.stringify({
				display: "unrelated project prompt",
				timestamp: 1700000120000,
				project: OTHER_SLUG,
			}),
			"{not valid json",
			"",
		].join("\n"),
	);

	// projects/<slug>/sess1.jsonl: valid transcript with one malformed line.
	const slugDir = join(claudeDir, "projects", cwdSlug);
	mkdirSync(slugDir, { recursive: true });
	writeFileSync(
		join(slugDir, "sess1.jsonl"),
		[
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "hello world, summarize me" },
				timestamp: "2024-01-01T00:00:00.000Z",
			}),
			"this line is not json at all",
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
				timestamp: "2024-01-01T00:05:00.000Z",
			}),
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "thanks" },
				timestamp: "2024-01-01T00:10:00.000Z",
			}),
			"",
		].join("\n"),
	);
	// Malformed file: no parseable timestamps -> no row, no throw.
	writeFileSync(join(slugDir, "garbage.jsonl"), "not json\nstill not json\n");
	// Foreign project transcript, only visible via WHERE project = ...
	const otherDir = join(claudeDir, "projects", OTHER_SLUG);
	mkdirSync(otherDir, { recursive: true });
	writeFileSync(
		join(otherDir, "sess2.jsonl"),
		`${JSON.stringify({
			type: "user",
			message: { role: "user", content: "other project session" },
			timestamp: "2024-02-01T00:00:00.000Z",
		})}\n`,
	);

	// Throwaway git repo with 2 commits.
	repoDir = mkdtempSync(join(tmpdir(), "dbg-tables-dev-repo-"));
	git(repoDir, "init", "-q");
	git(repoDir, "config", "user.email", "test@example.com");
	git(repoDir, "config", "user.name", "Test User");
	const nowSeconds = Math.floor(Date.now() / 1000);
	writeFileSync(join(repoDir, "a.txt"), "one\n");
	git(repoDir, "add", ".");
	gitCommitAt(repoDir, nowSeconds - 120, "first commit");
	writeFileSync(join(repoDir, "a.txt"), "two\n");
	writeFileSync(join(repoDir, "b.txt"), "new file\n");
	git(repoDir, "add", ".");
	gitCommitAt(repoDir, nowSeconds - 60, "second commit");
});

afterAll(() => {
	if (savedClaudeDir === undefined) {
		Reflect.deleteProperty(process.env, "DBG_CLAUDE_DIR");
	} else {
		process.env.DBG_CLAUDE_DIR = savedClaudeDir;
	}
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
	resetSessionCache();
});

describe("commits table", () => {
	it("returns rows recent-first with epoch-ms ts and JSON files array", async () => {
		const direct = await commitsTable.fetch(
			{ type: "comparison", column: "repo", op: "=", value: repoDir },
			createDevExecutor(),
		);
		expect(direct.columns).toEqual([
			"hash",
			"short_hash",
			"ts",
			"author",
			"summary",
			"files",
			"repo",
		]);
		expect(direct.rows).toHaveLength(2);

		const [newest, oldest] = direct.rows;
		// recent-first ordering
		expect(newest[4]).toBe("second commit");
		expect(oldest[4]).toBe("first commit");
		// ts is an epoch-ms integer (not seconds)
		for (const row of direct.rows) {
			expect(Number.isInteger(row[2])).toBe(true);
			expect(row[2] as number).toBeGreaterThan(1e12);
		}
		expect(newest[2] as number).toBeGreaterThanOrEqual(oldest[2] as number);
		// files JSON array is correct
		expect(JSON.parse(newest[5] as string).sort()).toEqual(["a.txt", "b.txt"]);
		expect(JSON.parse(oldest[5] as string)).toEqual(["a.txt"]);
		// hash formats
		expect(newest[0]).toMatch(/^[0-9a-f]{40}$/);
		expect(String(newest[1]).length).toBeGreaterThanOrEqual(7);
	});

	it("supports WHERE repo override through the engine", async () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		const result = await executeQuery(
			`SELECT summary FROM commits WHERE repo = '${repoDir}' ORDER BY ts ASC`,
			createDevExecutor(),
			registry,
		);
		expect(result.rows).toEqual([["first commit"], ["second commit"]]);
	});

	it("returns empty rows for a non-repo path instead of throwing", async () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "dbg-tables-dev-nonrepo-"));
		try {
			const result = await commitsTable.fetch(
				{ type: "comparison", column: "repo", op: "=", value: nonRepo },
				createDevExecutor(),
			);
			expect(result.rows).toEqual([]);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});
});

describe("agent_prompts table", () => {
	it("normalizes epoch-ms from number and numeric-string timestamps", async () => {
		const result = await agentPromptsTable.fetch(null, createDevExecutor());
		expect(result.columns).toEqual(["ts", "display", "project"]);
		// WHERE-less fetch scopes to the current project slug (slugged and
		// raw-path entries alike); malformed line and foreign-project entry
		// are excluded.
		expect(result.rows).toHaveLength(3);
		expect(result.rows[0][0]).toBe(PROMPT_TS_NUMBER);
		expect(result.rows[1][0]).toBe(Number(PROMPT_TS_STRING));
		expect(result.rows[2][1]).toBe("raw path entry");
		for (const row of result.rows) {
			expect(typeof row[0]).toBe("number");
			expect(row[2]).toBe(cwdSlug);
		}
	});

	it("filters by project slug through the engine", async () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		const result = await executeQuery(
			`SELECT display FROM agent_prompts WHERE project = '${OTHER_SLUG}'`,
			createDevExecutor(),
			registry,
		);
		expect(result.rows).toEqual([["unrelated project prompt"]]);
	});

	it("returns all projects via WHERE project LIKE '%'", async () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		const result = await executeQuery(
			"SELECT display FROM agent_prompts WHERE project LIKE '%'",
			createDevExecutor(),
			registry,
		);
		expect(result.rows).toHaveLength(4);
	});
});

describe("agent_sessions table", () => {
	it("summarizes current-project transcripts and skips malformed files", async () => {
		const result = await agentSessionsTable.fetch(null, createDevExecutor());
		expect(result.columns).toEqual([
			"session_id",
			"project",
			"ts_first",
			"ts_last",
			"title",
			"message_count",
		]);
		// garbage.jsonl yields no row; foreign project not scanned by default
		expect(result.rows).toHaveLength(1);
		const [row] = result.rows;
		expect(row[0]).toBe("sess1");
		expect(row[1]).toBe(cwdSlug);
		expect(row[2]).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
		expect(row[3]).toBe(Date.parse("2024-01-01T00:10:00.000Z"));
		expect(row[2] as number).toBeLessThan(row[3] as number);
		expect(row[4]).toBe("hello world, summarize me");
		// message_count = non-empty line count (malformed line included)
		expect(row[5]).toBe(4);
	});

	it("scans an explicit project via WHERE project = ... through the engine", async () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		const result = await executeQuery(
			`SELECT session_id, title FROM agent_sessions WHERE project = '${OTHER_SLUG}'`,
			createDevExecutor(),
			registry,
		);
		expect(result.rows).toEqual([["sess2", "other project session"]]);
	});

	it("caches per (path, mtime, size): second fetch parses nothing", async () => {
		await agentSessionsTable.fetch(null, createDevExecutor());
		const parsesAfterFirst = sessionScanStats.parses;
		expect(parsesAfterFirst).toBeGreaterThan(0);
		const second = await agentSessionsTable.fetch(null, createDevExecutor());
		expect(sessionScanStats.parses).toBe(parsesAfterFirst);
		expect(second.rows).toHaveLength(1);
	});
});

describe("dev tables through the engine (epoch-ms unification contract)", () => {
	// The dbg query engine is single-table (no JOIN in the parser), so the
	// cross-table join runs in test code over two engine queries. Both
	// tables expose `ts` in epoch-ms, which is what makes the join valid.
	it("joins agent_prompts to commits on a ts window", async () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		const executor = createDevExecutor();

		// Write a prompt whose ts is "now" so it lands in the same window
		// as the just-created git commits.
		const promptTs = Date.now();

		const commits = await executeQuery(
			`SELECT ts, summary FROM commits WHERE repo = '${repoDir}'`,
			executor,
			registry,
		);
		expect(commits.rows.length).toBe(2);

		const prompts = await executeQuery(
			"SELECT ts, display FROM agent_prompts WHERE project LIKE '%'",
			executor,
			registry,
		);
		expect(prompts.rows.length).toBe(4);

		// commits were created moments ago -> within an hour of `promptTs`
		const WINDOW_MS = 60 * 60 * 1000;
		const joined: Array<{ summary: unknown; display: unknown }> = [];
		for (const [commitTs, summary] of commits.rows) {
			for (const [ts, display] of prompts.rows) {
				const near = Math.abs((commitTs as number) - promptTs) <= WINDOW_MS;
				if (near && typeof ts === "number") {
					joined.push({ summary, display });
				}
			}
		}
		// Every commit (authored now) joins every prompt row via the window
		// on real epoch-ms values; if either side were in seconds or ISO
		// strings this would produce zero pairs.
		expect(joined.length).toBe(8);
	});

	it("COUNT(*) works against dev tables (daemon registry shape)", async () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		const result = await executeQuery(
			`SELECT COUNT(*) FROM commits WHERE repo = '${repoDir}'`,
			createDevExecutor(),
			registry,
		);
		expect(result.columns).toEqual(["count"]);
		expect(result.rows).toEqual([[2]]);
	});

	it("registers all three tables without colliding", () => {
		const registry = new TableRegistry();
		registerDevTables(registry);
		expect(registry.listTables().sort()).toEqual([
			"agent_prompts",
			"agent_sessions",
			"commits",
		]);
	});
});
