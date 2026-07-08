// `dbg why` blame ranking. Given a target error and the surrounding
// development signals (edits, epochs, commits, prompts) already gathered from
// the unified substrate, rank the likely causes and phrase a one-line answer.
// Pure and deterministic.

export interface WhyTarget {
	ts: number;
	text: string;
	/** Error stack text, used to boost edits whose file appears in it. */
	stack?: string;
}

export interface WhyEdit {
	ts: number;
	path: string;
	epochId: number | null;
}

export interface WhyEpoch {
	ts: number;
	id: number;
	name: string | null;
}

export interface WhyCommit {
	ts: number;
	shortHash: string;
	summary: string;
}

export interface WhyPrompt {
	ts: number;
	display: string;
}

export interface WhyCandidates {
	edits: WhyEdit[];
	epochs: WhyEpoch[];
	commits: WhyCommit[];
	prompts: WhyPrompt[];
}

export interface RankedEdit {
	path: string;
	ts: number;
	score: number;
	inStack: boolean;
	msBefore: number;
}

export interface WhyVerdict {
	error: { text: string; ts: number };
	edits: RankedEdit[];
	epoch: { id: number; name: string | null; ts: number } | null;
	commit: { shortHash: string; summary: string; ts: number } | null;
	prompt: { display: string; ts: number } | null;
	answer: string;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MAX_EDITS = 5;
const STACK_BONUS = 1;

function basename(p: string): string {
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

function latestAtOrBefore<T extends { ts: number }>(
	rows: T[],
	ts: number,
): T | null {
	let best: T | null = null;
	for (const row of rows) {
		if (row.ts <= ts && (best === null || row.ts > best.ts)) best = row;
	}
	return best;
}

export function rankCauses(
	target: WhyTarget,
	candidates: WhyCandidates,
	windowMs: number = DEFAULT_WINDOW_MS,
): WhyVerdict {
	const stack = (target.stack ?? "").toLowerCase();
	const lowerBound = target.ts - windowMs;

	const ranked: RankedEdit[] = candidates.edits
		.filter((e) => e.ts <= target.ts && e.ts >= lowerBound)
		.map((e) => {
			const msBefore = target.ts - e.ts;
			const recency = 1 - msBefore / windowMs; // 1 = just now, 0 = window edge
			const inStack =
				stack !== "" && stack.includes(basename(e.path).toLowerCase());
			return {
				path: e.path,
				ts: e.ts,
				inStack,
				msBefore,
				score: recency + (inStack ? STACK_BONUS : 0),
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_EDITS);

	const epochRow = latestAtOrBefore(candidates.epochs, target.ts);
	const commitRow = latestAtOrBefore(candidates.commits, target.ts);
	const promptRow = latestAtOrBefore(candidates.prompts, target.ts);

	const epoch = epochRow
		? { id: epochRow.id, name: epochRow.name, ts: epochRow.ts }
		: null;
	const commit = commitRow
		? {
				shortHash: commitRow.shortHash,
				summary: commitRow.summary,
				ts: commitRow.ts,
			}
		: null;
	const prompt = promptRow
		? { display: promptRow.display, ts: promptRow.ts }
		: null;

	return {
		error: { text: target.text, ts: target.ts },
		edits: ranked,
		epoch,
		commit,
		prompt,
		answer: buildAnswer(target, ranked, epoch, commit, prompt),
	};
}

function buildAnswer(
	target: WhyTarget,
	edits: RankedEdit[],
	epoch: WhyVerdict["epoch"],
	commit: WhyVerdict["commit"],
	prompt: WhyVerdict["prompt"],
): string {
	const head = `"${truncate(target.text, 80)}" first seen ${new Date(target.ts).toISOString()}`;
	const top = edits[0];
	if (!top) {
		const parts: string[] = [];
		if (epoch) parts.push(epochLabel(epoch));
		if (commit)
			parts.push(
				`commit ${commit.shortHash} "${truncate(commit.summary, 60)}"`,
			);
		if (prompt) parts.push(`prompt: "${truncate(prompt.display, 60)}"`);
		return parts.length > 0
			? `${head} — no edits in the preceding window; nearest context: ${parts.join(", ")}`
			: `${head} — no preceding edits, epoch, commit, or prompt found`;
	}
	const context: string[] = [];
	if (epoch) context.push(epochLabel(epoch));
	if (prompt) context.push(`prompt: "${truncate(prompt.display, 60)}"`);
	const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
	const stackNote = top.inStack ? " — its file is in the stack trace" : "";
	return `${head}, ${formatMs(top.msBefore)} after you saved ${top.path}${suffix}${stackNote}`;
}

function epochLabel(epoch: NonNullable<WhyVerdict["epoch"]>): string {
	return epoch.name
		? `epoch ${epoch.id}: "${epoch.name}"`
		: `epoch ${epoch.id}`;
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
