// `agent_sessions` — per-session summaries of Claude Code transcripts in
// ~/.claude/projects/<slug>/*.jsonl.
//
// Parsing every transcript on every query would be slow, so scanning is
// lazy: only the current cwd's slug directory is read by default. A WHERE
// clause referencing `project` widens the scan (an equality picks that one
// slug directory; anything else scans all slug directories) and the engine
// applies the actual filter afterwards.
//
// Summary rows are derived cheaply per file: ts_first/ts_last are the
// first/last lines' timestamps (ISO-8601 -> epoch-ms), title is the first
// user message's first ~80 chars when trivially reachable, message_count
// is the non-empty line count. Results are cached in-memory per process,
// keyed by (path, mtime, size). Malformed lines are skipped; a file with
// no parseable timestamp yields no row. Never throws.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { extractFilterValue, type VirtualTable } from "@dbg/query";

import {
	claudeDir,
	projectSlug,
	scopeCwd,
	toEpochMs,
	whereReferencesColumn,
} from "./internal.js";

const TITLE_MAX = 80;

interface SessionRow {
	sessionId: string;
	project: string;
	tsFirst: number;
	tsLast: number;
	title: string | null;
	messageCount: number;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	row: SessionRow | null;
}

const cache = new Map<string, CacheEntry>();

// Observability for tests: counts actual transcript parses (cache misses).
export const sessionScanStats = { parses: 0 };

export function resetSessionCache(): void {
	cache.clear();
	sessionScanStats.parses = 0;
}

function extractTitle(record: Record<string, unknown>): string | null {
	if (record.type !== "user") return null;
	const message = record.message;
	if (typeof message !== "object" || message === null) return null;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content.slice(0, TITLE_MAX);
	if (Array.isArray(content)) {
		for (const part of content) {
			if (
				typeof part === "object" &&
				part !== null &&
				typeof (part as Record<string, unknown>).text === "string"
			) {
				return ((part as Record<string, unknown>).text as string).slice(
					0,
					TITLE_MAX,
				);
			}
		}
	}
	return null;
}

async function summarizeTranscript(
	path: string,
	sessionId: string,
	project: string,
): Promise<SessionRow | null> {
	sessionScanStats.parses++;
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return null;
	}

	let tsFirst: number | null = null;
	let tsLast: number | null = null;
	let title: string | null = null;
	let messageCount = 0;

	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		messageCount++;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue; // malformed line — skip
		}
		if (typeof record !== "object" || record === null) continue;
		const obj = record as Record<string, unknown>;
		const ts = toEpochMs(obj.timestamp);
		if (ts !== null) {
			if (tsFirst === null) tsFirst = ts;
			tsLast = ts;
		}
		if (title === null) title = extractTitle(obj);
	}

	if (tsFirst === null || tsLast === null) return null; // malformed file
	return { sessionId, project, tsFirst, tsLast, title, messageCount };
}

async function scanSlugDir(
	projectsDir: string,
	slug: string,
): Promise<SessionRow[]> {
	let entries: string[];
	try {
		entries = await readdir(join(projectsDir, slug));
	} catch {
		return [];
	}

	const rows: SessionRow[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(projectsDir, slug, entry);
		let info: { mtimeMs: number; size: number };
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		const cached = cache.get(path);
		let row: SessionRow | null;
		if (
			cached &&
			cached.mtimeMs === info.mtimeMs &&
			cached.size === info.size
		) {
			row = cached.row;
		} else {
			row = await summarizeTranscript(
				path,
				entry.slice(0, -".jsonl".length),
				slug,
			);
			cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, row });
		}
		if (row) rows.push(row);
	}
	return rows;
}

export const agentSessionsTable: VirtualTable = {
	name: "agent_sessions",
	columns: [
		"session_id",
		"project",
		"ts_first",
		"ts_last",
		"title",
		"message_count",
	],
	async fetch(where, _executor) {
		const projectsDir = join(claudeDir(), "projects");

		let slugs: string[];
		const projectFilter = extractFilterValue(where, "project");
		if (typeof projectFilter === "string") {
			slugs = [projectFilter];
		} else if (whereReferencesColumn(where, "project")) {
			try {
				slugs = await readdir(projectsDir);
			} catch {
				slugs = [];
			}
		} else {
			slugs = [projectSlug(scopeCwd())];
		}

		const rows: unknown[][] = [];
		for (const slug of slugs) {
			for (const row of await scanSlugDir(projectsDir, slug)) {
				rows.push([
					row.sessionId,
					row.project,
					row.tsFirst,
					row.tsLast,
					row.title,
					row.messageCount,
				]);
			}
		}

		return { columns: this.columns, rows };
	},
};
