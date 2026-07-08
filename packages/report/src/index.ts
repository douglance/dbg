/**
 * @dbg/report — self-contained HTML report + timeline rendering.
 * Zero runtime dependencies; output embeds all assets as base64 data URIs
 * (CSP-safe: no CDN, no fonts, no external references of any kind).
 */

/** Axis-aligned rectangle in pixel coordinates. */
export interface ReportRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ReportRegion {
	box: ReportRect;
	label: string;
}

export interface StyleChange {
	selector: string;
	prop: string;
	before: string;
	after: string;
}

export interface NewError {
	type: string;
	text: string;
	ts: number;
}

export interface NetworkFailure {
	url: string;
	ts: number;
	method?: string;
	status?: number | string;
	text?: string;
}

export interface PairStats {
	diffPixels: number;
	totalPixels: number;
	diffPercent: number;
	width: number;
	height: number;
	dimensionsChanged: boolean;
}

export interface NetworkDiffReport {
	added: Array<{
		method: string;
		pattern: string;
		url: string;
		status: number;
	}>;
	removed: Array<{
		method: string;
		pattern: string;
		url: string;
		status: number;
	}>;
	statusChanged: Array<{
		method: string;
		pattern: string;
		url: string;
		before: number;
		after: number;
	}>;
	durationDelta: Array<{
		method: string;
		pattern: string;
		url: string;
		deltaMs: number;
	}>;
}

export interface StateChangeReport {
	kind: string;
	key: string;
	change: string;
	before: unknown;
	after: unknown;
}

export interface A11yIssueReport {
	rule: string;
	selector: string;
	detail: string;
}

export interface PerfDeltaReport {
	lcp: { anchor: number | null; after: number | null; delta: number | null };
	cls: { anchor: number; after: number; delta: number };
	longtasks: { newCount: number };
	jsHeap: { anchor: number | null; after: number | null; delta: number | null };
	bundleBytes: {
		anchor: number | null;
		after: number | null;
		delta: number | null;
	};
	interactions: { count: number; maxDuration: number };
}

export interface ReportPair {
	name: string;
	beforePng: Buffer;
	afterPng: Buffer;
	diffPng: Buffer;
	stats: PairStats;
	regions?: ReportRegion[];
	styleChanges?: StyleChange[];
	newErrors?: NewError[];
	newNetworkFailures?: NetworkFailure[];
	networkDiff?: NetworkDiffReport;
	stateChanges?: StateChangeReport[];
	a11yIssues?: A11yIssueReport[];
	perfDelta?: PerfDeltaReport;
}

export interface ReportMeta {
	generatedAt: string;
	anchor: string;
}

export interface ReportInput {
	pairs: ReportPair[];
	meta: ReportMeta;
}

export interface TimelineFrame {
	ts: number;
	/** Frame pixels. Absent for metadata-only frames (retention-decayed):
	 * those render as a placeholder card with annotations intact. */
	thumbPng?: Buffer;
	/** Retention tier of the capture ('full' | 'thumb' | 'meta'). */
	tier?: "full" | "thumb" | "meta";
	url: string;
	changedFiles?: string[];
	hmrModules?: string[];
	epochName?: string;
	logCounts?: Record<string, number>;
	/** Capture id used in the `dbg after --at capture:<ID>` command. Defaults to `ts`. */
	id?: string | number;
}

/** A git commit rendered as a chip interleaved into the timeline strip. */
export interface TimelineCommit {
	ts: number;
	shortHash: string;
	summary: string;
}

/** An agent prompt rendered as a chip interleaved into the timeline strip. */
export interface TimelinePrompt {
	ts: number;
	text: string;
}

export interface TimelineInput {
	frames: TimelineFrame[];
	/** Commit chips positioned between frame cards by ts. */
	commits?: TimelineCommit[];
	/** Prompt chips positioned between frame cards by ts. */
	prompts?: TimelinePrompt[];
	/** totalFrames: full capture count when the strip is truncated to the
	 * most recent N — the header then reads "showing last N of M". */
	meta?: { generatedAt?: string; totalFrames?: number };
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function pngUri(buf: Buffer): string {
	return `data:image/png;base64,${buf.toString("base64")}`;
}

function pct(v: number, total: number): string {
	return total > 0 ? `${((v / total) * 100).toFixed(3)}%` : "0%";
}

const SHARED_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0e1117;color:#dde3ec;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:24px}
header{margin-bottom:24px}
h1{font-size:20px;font-weight:600}
h2{font-size:16px;font-weight:600}
h3{font-size:13px;font-weight:600;color:#aeb8c9;text-transform:uppercase;letter-spacing:.04em}
.meta{color:#8b95a7;font-size:12px;margin-top:4px}
code,pre{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#0a0d12;border:1px solid #232b3a;border-radius:6px;padding:10px 12px;overflow:auto}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;line-height:1.6;white-space:nowrap}
.badge.red{background:#3b1519;color:#ff6369;border:1px solid #7f2b31}
.badge.dim{background:#1d2430;color:#8b95a7;border:1px solid #2a3446}
.badge.amber{background:#3a2a10;color:#ffb224;border:1px solid #6f5420}
`;

const REPORT_CSS = `${SHARED_CSS}
.pair{background:#161b24;border:1px solid #232b3a;border-radius:10px;padding:16px;margin-bottom:24px}
.stats{display:flex;gap:16px;align-items:center;color:#8b95a7;font-size:12px;margin-top:6px;flex-wrap:wrap}
.stats .pctval{color:#dde3ec;font-weight:600}
.tabs{display:flex;gap:8px;margin:14px 0 12px}
.tabs button{background:#1d2430;color:#aeb8c9;border:1px solid #2a3446;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;font-size:12px}
.tabs button.active{background:#274064;color:#dbe9ff;border-color:#3a5a8a}
.view{display:none}
.view.active{display:block}
.sbs{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:1200px}
.sbs img{width:100%;display:block;border:1px solid #232b3a;background:#000}
.sbs figcaption{color:#8b95a7;font-size:11px;margin-top:4px;text-align:center}
.stage{position:relative;width:100%;max-width:900px;background:#000;border:1px solid #232b3a;overflow:hidden}
.stage img{position:absolute;inset:0;width:100%;height:100%;display:block}
.stage img.dimmed{filter:brightness(.35)}
.region{position:absolute;border:1.5px solid #ffb224;background:rgba(255,178,36,.12)}
.region span{position:absolute;top:-18px;left:-2px;background:#ffb224;color:#000;font-size:10px;padding:0 4px;border-radius:3px;white-space:nowrap}
input[type=range]{width:100%;max-width:900px;margin-top:10px;accent-color:#4ea1ff}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:16px}
.panel{background:#12161e;border:1px solid #232b3a;border-radius:8px;padding:12px}
.panel ul{list-style:none;margin-top:8px;display:flex;flex-direction:column;gap:6px}
.panel li{font-size:12px;color:#c4cddb}
.panel .sel{color:#4ea1ff}
.panel .arrow{color:#8b95a7;padding:0 4px}
.panel .was{color:#ff6369;text-decoration:line-through}
.panel .now{color:#46c78f}
.panel .when{color:#586274;font-size:11px;padding-left:6px}
`;

const REPORT_JS = `
(function () {
	document.querySelectorAll(".pair").forEach(function (pair) {
		var tabs = pair.querySelectorAll(".tabs button");
		var views = pair.querySelectorAll(".view");
		tabs.forEach(function (btn) {
			btn.addEventListener("click", function () {
				tabs.forEach(function (b) { b.classList.toggle("active", b === btn); });
				views.forEach(function (v) {
					v.classList.toggle("active", v.getAttribute("data-view") === btn.getAttribute("data-view"));
				});
			});
		});
		var wipeRange = pair.querySelector(".wipe-range");
		var wipeTop = pair.querySelector('.view[data-view="wipe"] .top');
		if (wipeRange && wipeTop) {
			wipeRange.addEventListener("input", function () {
				wipeTop.style.clipPath = "inset(0 " + (100 - Number(wipeRange.value)) + "% 0 0)";
			});
		}
		var onionRange = pair.querySelector(".onion-range");
		var onionTop = pair.querySelector('.view[data-view="onion"] .top');
		if (onionRange && onionTop) {
			onionRange.addEventListener("input", function () {
				onionTop.style.opacity = String(Number(onionRange.value) / 100);
			});
		}
	});
})();
`;

function renderRegions(regions: ReportRegion[], stats: PairStats): string {
	return regions
		.map(
			(r) =>
				`<div class="region" style="left:${pct(r.box.x, stats.width)};top:${pct(r.box.y, stats.height)};width:${pct(r.box.w, stats.width)};height:${pct(r.box.h, stats.height)}"><span>${esc(r.label)}</span></div>`,
		)
		.join("");
}

function renderStyleChangesPanel(changes: StyleChange[]): string {
	if (changes.length === 0) return "";
	const items = changes
		.map(
			(c) =>
				`<li><span class="sel">${esc(c.selector)}</span> <code>${esc(c.prop)}</code>: <span class="was">${esc(c.before)}</span><span class="arrow">→</span><span class="now">${esc(c.after)}</span></li>`,
		)
		.join("");
	return `<section class="panel"><h3>What changed</h3><ul>${items}</ul></section>`;
}

function renderErrorsPanel(errors: NewError[]): string {
	if (errors.length === 0) return "";
	const items = errors
		.map(
			(e) =>
				`<li><span class="badge red">${esc(e.type)}</span> ${esc(e.text)}<span class="when">${esc(new Date(e.ts).toISOString())}</span></li>`,
		)
		.join("");
	return `<section class="panel"><h3>New errors <span class="badge red">${errors.length}</span></h3><ul>${items}</ul></section>`;
}

function renderNetworkPanel(failures: NetworkFailure[]): string {
	if (failures.length === 0) return "";
	const items = failures
		.map((f) => {
			const status =
				f.status === undefined
					? ""
					: `<span class="badge red">${esc(String(f.status))}</span> `;
			const method = f.method ? `<code>${esc(f.method)}</code> ` : "";
			const text = f.text ? ` — ${esc(f.text)}` : "";
			return `<li>${status}${method}${esc(f.url)}${text}<span class="when">${esc(new Date(f.ts).toISOString())}</span></li>`;
		})
		.join("");
	return `<section class="panel"><h3>New network failures <span class="badge red">${failures.length}</span></h3><ul>${items}</ul></section>`;
}

function renderNetworkDiffPanel(diff?: NetworkDiffReport): string {
	if (!diff) return "";
	const items: string[] = [];
	for (const a of diff.added) {
		items.push(
			`<li><span class="badge amber">added</span> <code>${esc(a.method)}</code> ${esc(a.pattern)} <span class="badge dim">${esc(String(a.status))}</span></li>`,
		);
	}
	for (const r of diff.removed) {
		items.push(
			`<li><span class="badge dim">removed</span> <code>${esc(r.method)}</code> ${esc(r.pattern)}</li>`,
		);
	}
	for (const s of diff.statusChanged) {
		items.push(
			`<li><span class="badge red">status</span> <code>${esc(s.method)}</code> ${esc(s.pattern)} <span class="was">${esc(String(s.before))}</span><span class="arrow">→</span><span class="now">${esc(String(s.after))}</span></li>`,
		);
	}
	for (const d of diff.durationDelta) {
		const sign = d.deltaMs > 0 ? "+" : "";
		items.push(
			`<li><span class="badge amber">timing</span> <code>${esc(d.method)}</code> ${esc(d.pattern)} <span class="now">${sign}${esc(String(d.deltaMs))}ms</span></li>`,
		);
	}
	if (items.length === 0) return "";
	return `<section class="panel"><h3>Network diff <span class="badge amber">${items.length}</span></h3><ul>${items.join("")}</ul></section>`;
}

function renderStateChangesPanel(changes: StateChangeReport[]): string {
	if (changes.length === 0) return "";
	const preview = (value: unknown): string => {
		if (value === undefined) return "∅";
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return esc(text.length > 60 ? `${text.slice(0, 59)}…` : text);
	};
	const badge: Record<string, string> = {
		added: "amber",
		removed: "dim",
		changed: "red",
	};
	const items = changes
		.map(
			(c) =>
				`<li><span class="badge ${badge[c.change] ?? "dim"}">${esc(c.change)}</span> <span class="sel">${esc(c.kind)}</span> <code>${esc(c.key)}</code>: <span class="was">${preview(c.before)}</span><span class="arrow">→</span><span class="now">${preview(c.after)}</span></li>`,
		)
		.join("");
	return `<section class="panel"><h3>State changes <span class="badge amber">${changes.length}</span></h3><ul>${items}</ul></section>`;
}

function renderA11yPanel(issues: A11yIssueReport[]): string {
	if (issues.length === 0) return "";
	const items = issues
		.map(
			(i) =>
				`<li><span class="badge red">${esc(i.rule)}</span> <span class="sel">${esc(i.selector)}</span> — ${esc(i.detail)}</li>`,
		)
		.join("");
	return `<section class="panel"><h3>New a11y issues <span class="badge red">${issues.length}</span></h3><ul>${items}</ul></section>`;
}

function renderPerfPanel(delta?: PerfDeltaReport): string {
	if (!delta) return "";
	const fmtMs = (v: number | null): string =>
		v == null ? "—" : `${Math.round(v)}ms`;
	const signed = (v: number): string =>
		`${v >= 0 ? "+" : ""}${v.toLocaleString("en-US")}`;
	const items: string[] = [];
	if (delta.lcp.after != null || delta.lcp.anchor != null) {
		const d = delta.lcp.delta;
		const trail = d != null ? ` (${d >= 0 ? "+" : ""}${Math.round(d)}ms)` : "";
		items.push(
			`<li>ΔLCP <span class="now">${fmtMs(delta.lcp.after)}</span> <span class="was">${fmtMs(delta.lcp.anchor)}</span>${trail}</li>`,
		);
	}
	items.push(
		`<li>ΔCLS <span class="now">${delta.cls.delta.toFixed(3)}</span></li>`,
	);
	if (delta.longtasks.newCount > 0) {
		items.push(
			`<li>new longtasks <span class="badge amber">${delta.longtasks.newCount}</span></li>`,
		);
	}
	if (delta.jsHeap.delta != null) {
		items.push(
			`<li>ΔJSHeap <span class="now">${signed(delta.jsHeap.delta)} B</span></li>`,
		);
	}
	if (delta.bundleBytes.delta != null) {
		items.push(
			`<li>Δbundle_bytes <span class="now">${signed(delta.bundleBytes.delta)} B</span></li>`,
		);
	}
	if (delta.interactions.count > 0) {
		items.push(
			`<li>interactions during flows <span class="badge dim">${delta.interactions.count}</span> (max ${Math.round(delta.interactions.maxDuration)}ms)</li>`,
		);
	}
	return `<section class="panel"><h3>Performance</h3><ul>${items.join("")}</ul></section>`;
}

function renderPair(pair: ReportPair, index: number): string {
	const before = pngUri(pair.beforePng);
	const after = pngUri(pair.afterPng);
	const diff = pngUri(pair.diffPng);
	const s = pair.stats;
	const aspect =
		s.width > 0 && s.height > 0 ? `aspect-ratio:${s.width}/${s.height}` : "";
	const dimBadge = s.dimensionsChanged
		? '<span class="badge amber">dimensions changed</span>'
		: "";
	const regions = renderRegions(pair.regions ?? [], s);
	return `<section class="pair" id="pair-${index}">
	<h2>${esc(pair.name)}</h2>
	<div class="stats">
		<span class="pctval">${s.diffPercent.toFixed(2)}% changed</span>
		<span>${s.diffPixels.toLocaleString("en-US")} / ${s.totalPixels.toLocaleString("en-US")} px</span>
		<span>${s.width}×${s.height}</span>
		${dimBadge}
	</div>
	<nav class="tabs">
		<button type="button" class="active" data-view="sbs">Side by side</button>
		<button type="button" data-view="wipe">Wipe</button>
		<button type="button" data-view="onion">Onion skin</button>
		<button type="button" data-view="diff">Diff overlay</button>
	</nav>
	<div class="view active" data-view="sbs">
		<div class="sbs">
			<figure><img src="${before}" alt="before"><figcaption>before</figcaption></figure>
			<figure><img src="${after}" alt="after"><figcaption>after</figcaption></figure>
		</div>
	</div>
	<div class="view" data-view="wipe">
		<div class="stage" style="${aspect}">
			<img class="base" src="${before}" alt="before">
			<img class="top" src="${after}" alt="after" style="clip-path:inset(0 50% 0 0)">
		</div>
		<input type="range" class="wipe-range" min="0" max="100" value="50" aria-label="wipe position">
	</div>
	<div class="view" data-view="onion">
		<div class="stage" style="${aspect}">
			<img class="base" src="${before}" alt="before">
			<img class="top" src="${after}" alt="after" style="opacity:0.5">
		</div>
		<input type="range" class="onion-range" min="0" max="100" value="50" aria-label="after opacity">
	</div>
	<div class="view" data-view="diff">
		<div class="stage" style="${aspect}">
			<img class="base dimmed" src="${before}" alt="before">
			<img class="top" src="${diff}" alt="diff">
			${regions}
		</div>
	</div>
	<div class="panels">
		${renderStyleChangesPanel(pair.styleChanges ?? [])}
		${renderErrorsPanel(pair.newErrors ?? [])}
		${renderNetworkPanel(pair.newNetworkFailures ?? [])}
		${renderNetworkDiffPanel(pair.networkDiff)}
		${renderStateChangesPanel(pair.stateChanges ?? [])}
		${renderA11yPanel(pair.a11yIssues ?? [])}
		${renderPerfPanel(pair.perfDelta)}
	</div>
</section>`;
}

/** Render a self-contained before/after HTML report (all assets inlined). */
export function renderReport(input: ReportInput): string {
	const pairs = input.pairs.map((p, i) => renderPair(p, i)).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dbg report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
	<h1>dbg — before / after</h1>
	<div class="meta">anchor: <code>${esc(input.meta.anchor)}</code> · generated ${esc(input.meta.generatedAt)}</div>
</header>
${pairs}
<script>${REPORT_JS}</script>
</body>
</html>`;
}

const TIMELINE_CSS = `${SHARED_CSS}
.strip{display:flex;gap:12px;overflow-x:auto;padding:12px 4px 16px}
.frame{flex:0 0 auto;width:220px;background:#161b24;border:1px solid #232b3a;border-radius:8px;padding:8px;cursor:pointer}
.frame.selected{border-color:#4ea1ff;box-shadow:0 0 0 1px #4ea1ff}
.frame img{width:100%;display:block;border:1px solid #232b3a;background:#000;border-radius:4px}
.frame figcaption{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.frame .time{color:#8b95a7;font-size:11px}
.frame .url{font-size:12px;color:#c4cddb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.hint{color:#8b95a7;font-size:12px;margin-top:4px}
.instruct{background:#161b24;border:1px solid #3a5a8a;border-radius:10px;padding:16px;margin-top:16px;max-width:720px}
.instruct p{font-size:12px;color:#aeb8c9;margin:6px 0}
.instruct .fname{color:#dbe9ff}
.frame .placeholder{width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;border:1px dashed #3a4458;background:#0a0d12;border-radius:4px;color:#8b95a7;font-size:11px;text-align:center;padding:8px}
.marker{flex:0 0 auto;width:150px;align-self:stretch;display:flex;flex-direction:column;justify-content:center;gap:6px;border-radius:8px;padding:10px;font-size:12px}
.marker .marker-kind{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.marker .marker-text{color:#c4cddb;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}
.marker.commit{background:#12241a;border:1px solid #1f5133}
.marker.commit .marker-kind{color:#4ade80}
.marker.prompt{background:#1a1424;border:1px solid #4a2f6a}
.marker.prompt .marker-kind{color:#c084fc}
`;

const TIMELINE_JS = `
(function () {
	var selected = [];
	var frames = Array.prototype.slice.call(document.querySelectorAll(".frame"));
	var instruct = document.getElementById("instruct");
	var cmd = document.getElementById("cmd");
	var selA = document.getElementById("sel-a");
	var selB = document.getElementById("sel-b");
	function update() {
		frames.forEach(function (f) { f.classList.toggle("selected", selected.indexOf(f) >= 0); });
		if (selected.length !== 2) {
			instruct.hidden = true;
			return;
		}
		var pair = selected.slice().sort(function (a, b) {
			return Number(a.getAttribute("data-ts")) - Number(b.getAttribute("data-ts"));
		});
		selA.textContent = pair[0].getAttribute("data-label");
		selB.textContent = pair[1].getAttribute("data-label");
		cmd.textContent = "dbg after --at capture:" + pair[0].getAttribute("data-id");
		instruct.hidden = false;
	}
	frames.forEach(function (frame) {
		frame.addEventListener("click", function () {
			var i = selected.indexOf(frame);
			if (i >= 0) {
				selected.splice(i, 1);
			} else {
				if (selected.length === 2) selected.shift();
				selected.push(frame);
			}
			update();
		});
	});
})();
`;

function chips(values: string[], cls: string): string {
	if (values.length === 0) return "";
	return `<div class="chips">${values.map((v) => `<span class="badge ${cls}">${esc(v)}</span>`).join("")}</div>`;
}

function logCountBadges(counts: Record<string, number>): string {
	const entries = Object.entries(counts).filter(([, n]) => n > 0);
	if (entries.length === 0) return "";
	return `<div class="chips">${entries
		.map(
			([type, n]) =>
				`<span class="badge ${type === "error" || type === "exception" ? "red" : "dim"}">${esc(type)}×${n}</span>`,
		)
		.join("")}</div>`;
}

function renderFrame(frame: TimelineFrame, index: number): string {
	const id = frame.id ?? frame.ts;
	const iso = new Date(frame.ts).toISOString();
	const label = `frame ${index} (capture:${id})`;
	const epoch = frame.epochName
		? `<div class="chips"><span class="badge amber">${esc(frame.epochName)}</span></div>`
		: "";
	const visual = frame.thumbPng
		? `<img src="${pngUri(frame.thumbPng)}" alt="frame ${index}">`
		: `<div class="placeholder">pixels pruned (metadata only)</div>`;
	return `<figure class="frame" data-id="${esc(String(id))}" data-ts="${frame.ts}" data-label="${esc(label)}" tabindex="0">
	${visual}
	<figcaption>
		<div class="time">${esc(iso)}</div>
		<div class="url" title="${esc(frame.url)}">${esc(frame.url)}</div>
		${epoch}
		${chips(frame.changedFiles ?? [], "dim")}
		${chips(frame.hmrModules ?? [], "dim")}
		${logCountBadges(frame.logCounts ?? {})}
	</figcaption>
</figure>`;
}

function renderCommitChip(commit: TimelineCommit): string {
	const iso = new Date(commit.ts).toISOString();
	return `<div class="marker commit" data-ts="${commit.ts}" title="${esc(commit.summary)}">
	<div class="marker-kind">commit ${esc(commit.shortHash)}</div>
	<div class="marker-text">${esc(commit.summary)}</div>
	<div class="time">${esc(iso)}</div>
</div>`;
}

function renderPromptChip(prompt: TimelinePrompt): string {
	const iso = new Date(prompt.ts).toISOString();
	return `<div class="marker prompt" data-ts="${prompt.ts}" title="${esc(prompt.text)}">
	<div class="marker-kind">prompt</div>
	<div class="marker-text">${esc(prompt.text)}</div>
	<div class="time">${esc(iso)}</div>
</div>`;
}

/** Render a self-contained timeline filmstrip HTML page (all assets inlined). */
export function renderTimeline(input: TimelineInput): string {
	// Merge frames and commit/prompt markers into one ts-ordered strip. Frames
	// keep their original 0-based index for the "frame N (capture:ID)" label.
	const entries: Array<{ ts: number; order: number; html: string }> = [];
	input.frames.forEach((f, i) => {
		entries.push({ ts: f.ts, order: 0, html: renderFrame(f, i) });
	});
	for (const commit of input.commits ?? []) {
		entries.push({ ts: commit.ts, order: 1, html: renderCommitChip(commit) });
	}
	for (const prompt of input.prompts ?? []) {
		entries.push({ ts: prompt.ts, order: 1, html: renderPromptChip(prompt) });
	}
	entries.sort((a, b) => a.ts - b.ts || a.order - b.order);
	const frames = entries.map((e) => e.html).join("\n");
	const generated = input.meta?.generatedAt
		? ` · generated ${esc(input.meta.generatedAt)}`
		: "";
	const total = input.meta?.totalFrames;
	const frameCountLabel =
		total !== undefined && total > input.frames.length
			? `showing last ${input.frames.length} of ${total} frames`
			: `${input.frames.length} frames`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dbg timeline</title>
<style>${TIMELINE_CSS}</style>
</head>
<body>
<header>
	<h1>dbg — timeline</h1>
	<div class="meta">${frameCountLabel}${generated}</div>
	<div class="hint">Click two frames to diff them.</div>
</header>
<div class="strip">
${frames}
</div>
<div class="instruct" id="instruct" hidden>
	<h3>Diff these two</h3>
	<p><span class="fname" id="sel-a"></span> → <span class="fname" id="sel-b"></span></p>
	<p>Run this command (the earlier frame is the anchor):</p>
	<pre><code id="cmd">dbg after --at capture:&lt;ID&gt;</code></pre>
</div>
<script>${TIMELINE_JS}</script>
</body>
</html>`;
}
