// `commits` — git log of a repository as a virtual table.
//
// Default repo is the daemon process cwd; override with WHERE repo =
// '/abs/path'. Rows carry the repo path in a `repo` column so the
// engine's post-fetch WHERE evaluation matches the override filter.
//
// `ts` is the author timestamp in epoch-milliseconds UTC (the unified
// timestamp contract shared by all dev tables). `files` is a JSON array
// of changed paths. Only the 500 most recent commits are fetched.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { extractFilterValue, type VirtualTable } from "@dbg/query";

const execFileAsync = promisify(execFile);

const COMMIT_LIMIT = 500;
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

export const commitsTable: VirtualTable = {
	name: "commits",
	columns: ["hash", "short_hash", "ts", "author", "summary", "files", "repo"],
	async fetch(where, _executor) {
		const repoFilter = extractFilterValue(where, "repo");
		const repo = typeof repoFilter === "string" ? repoFilter : process.cwd();

		let stdout: string;
		try {
			const result = await execFileAsync(
				"git",
				[
					"log",
					"-n",
					String(COMMIT_LIMIT),
					`--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%h${FIELD_SEP}%at${FIELD_SEP}%an${FIELD_SEP}%s`,
					"--name-only",
				],
				{ cwd: repo, maxBuffer: 64 * 1024 * 1024 },
			);
			stdout = result.stdout;
		} catch {
			// Not a git repo / git unavailable — empty result, never throw.
			return { columns: this.columns, rows: [] };
		}

		const rows: unknown[][] = [];
		for (const record of stdout.split(RECORD_SEP)) {
			if (record === "") continue;
			const fields = record.split(FIELD_SEP);
			if (fields.length < 5) continue;
			const [hash, shortHash, authoredAt, author] = fields;
			// The last field is "<summary>\n\n<file>\n<file>..." because
			// --name-only appends changed paths after the format line.
			const tail = fields.slice(4).join(FIELD_SEP);
			const tailLines = tail.split("\n");
			const summary = tailLines[0];
			const files = tailLines
				.slice(1)
				.map((line) => line.trim())
				.filter((line) => line !== "");
			const ts = Number(authoredAt) * 1000;
			if (!Number.isFinite(ts)) continue;
			rows.push([
				hash,
				shortHash,
				ts,
				author,
				summary,
				JSON.stringify(files),
				repo,
			]);
		}

		return { columns: this.columns, rows };
	},
};
