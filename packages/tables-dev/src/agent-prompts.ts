// `agent_prompts` — user prompts from Claude Code's ~/.claude/history.jsonl
// (one JSON object per line: { display, timestamp, project }).
//
// `ts` is epoch-milliseconds (the source stores epoch-ms as a number or a
// numeric string; both are normalized). `project` is exposed as the Claude
// Code project slug: the absolute project path with '/' and '.' replaced
// by '-' (e.g. -Users-doug-Developer-lv-dbg). The source file stores the
// raw absolute path in newer entries and the slug in older ones; both are
// normalized to the slug so the column matches agent_sessions' project
// key (the ~/.claude/projects/<slug> directory names).
//
// The full file is always parsed (it is a single cheap file). A WHERE
// clause that references `project` opts into explicit scoping (the engine
// applies the filter, e.g. WHERE project = '<slug>' or project LIKE '%'
// for all projects); otherwise rows default to the current cwd's slug.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { VirtualTable } from "@dbg/query";

import {
	claudeDir,
	projectSlug,
	toEpochMs,
	whereReferencesColumn,
} from "./internal.js";

export const agentPromptsTable: VirtualTable = {
	name: "agent_prompts",
	columns: ["ts", "display", "project"],
	async fetch(where, _executor) {
		let content: string;
		try {
			content = await readFile(join(claudeDir(), "history.jsonl"), "utf8");
		} catch {
			return { columns: this.columns, rows: [] };
		}

		const scoped = !whereReferencesColumn(where, "project");
		const currentSlug = projectSlug(process.cwd());

		const rows: unknown[][] = [];
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // malformed line — skip, never throw
			}
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const ts = toEpochMs(record.timestamp);
			if (ts === null) continue;
			// Raw absolute path -> slug; already-slugged values pass through
			// unchanged (a slug contains no '/' or '.').
			const project =
				typeof record.project === "string" ? projectSlug(record.project) : "";
			if (scoped && project !== currentSlug) continue;
			rows.push([ts, record.display ?? "", project]);
		}

		return { columns: this.columns, rows };
	},
};
