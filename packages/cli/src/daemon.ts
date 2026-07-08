// Background daemon: Unix socket server that receives JSON commands from CLI
// and dispatches to CDP command handlers
// Supports multiple concurrent CDP sessions via a session registry

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
	CdpClientWrapper,
	discoverTarget,
	listTargets,
} from "@dbg/adapter-cdp";
import { DapClientWrapper } from "@dbg/adapter-dap";
import { diffPngs } from "@dbg/diff";
import { renderReport, renderTimeline } from "@dbg/report";
import type { TimelineFrame } from "@dbg/report";
import { type LaunchedChrome, launchChrome } from "@dbg/launcher";
import {
	ATTACH_PLATFORMS,
	AppleDeviceProviderError,
	listAppleAttachTargets,
	listApps,
	parseAttachRequest,
	resolveAppleDeviceAttachTarget,
} from "@dbg/provider-apple-device";
import { executeQuery, TableRegistry } from "@dbg/query";
import { EventStore } from "@dbg/store";
import { registerBrowserTables } from "@dbg/tables-browser";
import { registerCoreTables } from "@dbg/tables-core";
import { registerNativeTables } from "@dbg/tables-native";
import {
	agentPromptsTable,
	commitsTable,
	registerDevTables,
	setScopeCwd,
	timelineTable,
} from "@dbg/tables-dev";
import { registerRecorderTables } from "@dbg/tables-recorder";
import type {
	AttachDiagnostics,
	AttachPlatform,
	Command,
	CssCoverageEntry,
	DaemonState,
	DebugExecutor,
	FlowRunResult,
	JsCoverageScript,
	Response,
	Session,
	SessionInfo,
	StoredBreakpoint,
} from "@dbg/types";
import { SOCKET_PATH, createEmptyDebuggerState } from "@dbg/types";
import { executeAttachWithStrategy } from "./attach-strategy.js";
import {
	handleContinue,
	handleDeleteBreakpoint,
	handleEval,
	handleHealth,
	handleListBreakpoints,
	handlePause,
	handleReconnect,
	handleSetBreakpoint,
	handleSource,
	handleStatus,
	handleStepInto,
	handleStepOut,
	handleStepOver,
	handleTrace,
} from "./commands.js";
import { killTarget, spawnTarget } from "./process.js";
import {
	type AnchorCaptureRow,
	type AnchorEpochRow,
	parseAnchorSpec,
	resolveAnchor,
} from "./recorder/anchor.js";
import { type AxTree, computeA11yIssues } from "./recorder/a11y.js";
import { parseHmrModules } from "./recorder/hmr.js";
import {
	computePerfDelta,
	parsePerfBatch,
	type PerfDelta,
	type PerfSampleRow,
} from "./perf.js";
import {
	diffNetwork,
	type NetRequest,
	type NetworkDiff,
} from "./recorder/netdiff.js";
import {
	applyRetention,
	DEFAULT_EVENTS_TTL_MS,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_FULL_FRAMES,
	type RetentionConfig,
	sessionRetentionStats,
} from "./recorder/retention.js";
import {
	buildRegions,
	capturePageSnapshot,
	diffSnapshots,
	type PageSnapshot,
} from "./recorder/snapshot.js";
import {
	type StateChange,
	diffStorage,
	type StorageSnapshot,
} from "./recorder/storage-diff.js";
import {
	buildTapCondition,
	parseTapSentinel,
	suffixUrlRegex,
} from "./recorder/taps.js";
import { isIgnoredWatchPath } from "./recorder/watch.js";
import {
	rankCauses,
	type WhyCandidates,
	type WhyVerdict,
} from "./recorder/why.js";
import { parseFlowAction } from "./flow-model.js";
import {
	replayClick,
	replayInput,
	replayKeypress,
	replayScroll,
	waitForActionable,
} from "./flow-replay.js";

import { spawn } from "node:child_process";
import * as http from "node:http";
import * as os from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";

// ─── State ───

function createState(): DaemonState {
	return createEmptyDebuggerState();
}

const store = new EventStore();
const tableRegistry = new TableRegistry();
registerCoreTables(tableRegistry);
registerBrowserTables(tableRegistry);
registerNativeTables(tableRegistry);
registerRecorderTables(tableRegistry);
registerDevTables(tableRegistry);
tableRegistry.register(timelineTable);

// Route tap-logpoint console sentinels (`__dbg_tap:<id>`) → tap_hits rows and
// suppress them from the user-visible console/events sinks. Installed once; the
// single choke upstream of both state.console and the persisted events store.
CdpClientWrapper.eventInterceptor = (method, eventParams) => {
	if (method !== "Runtime.consoleAPICalled") return false;
	const hit = parseTapSentinel(
		(eventParams as { args?: unknown } | null)?.args,
	);
	if (!hit) return false;
	store.insertTapHit({ tapId: hit.tapId, value: hit.value });
	return true;
};

const registry = {
	sessions: new Map<string, Session>(),
	current: null as string | null,
};

let sessionCounter = 0;

function nextSessionName(): string {
	while (registry.sessions.has(`s${sessionCounter}`)) {
		sessionCounter++;
	}
	return `s${sessionCounter++}`;
}

store.record(
	{
		source: "daemon",
		category: "lifecycle",
		method: "daemon.start",
		data: { pid: process.pid },
	},
	true,
);

// ─── Session resolution ───

function resolveSession(name?: string): Session | null {
	// Explicit name -> look up in map
	if (name) return registry.sessions.get(name) ?? null;
	// Only one session -> return it
	if (registry.sessions.size === 1)
		return registry.sessions.values().next().value ?? null;
	// Current set -> return that
	if (registry.current) return registry.sessions.get(registry.current) ?? null;
	// Otherwise null
	return null;
}

function asCdpExecutor(session: Session): CdpClientWrapper | null {
	return session.executor.protocol === "cdp"
		? (session.executor as CdpClientWrapper)
		: null;
}

function _asDapExecutor(session: Session): DapClientWrapper | null {
	return session.executor.protocol === "dap"
		? (session.executor as DapClientWrapper)
		: null;
}

function findSessionByPid(pid: number): Session | null {
	for (const session of registry.sessions.values()) {
		if (!session.state.connected) continue;
		if (session.state.pid === pid) {
			return session;
		}
	}
	return null;
}

function formatAttachDiagnostics(diagnostics: AttachDiagnostics): string[] {
	const lines: string[] = [];
	lines.push(
		`attach strategy: requested=${diagnostics.requestedStrategy}, selected=${diagnostics.selectedStrategy ?? "none"}`,
	);
	lines.push(
		`attach timings: providerResolveMs=${diagnostics.providerResolveMs}, totalMs=${diagnostics.totalMs}`,
	);
	for (const attempt of diagnostics.attemptedStrategies) {
		lines.push(
			`attach attempt: strategy=${attempt.strategy}, success=${attempt.success}, durationMs=${attempt.durationMs}${attempt.error ? `, error=${attempt.error}` : ""}`,
		);
	}
	return lines;
}

function createEmptyAttachDiagnostics(
	requestedStrategy: AttachDiagnostics["requestedStrategy"],
	providerResolveMs: number,
): AttachDiagnostics {
	return {
		requestedStrategy,
		attemptedStrategies: [],
		selectedStrategy: null,
		providerResolveMs,
		totalMs: providerResolveMs,
	};
}

function formatProviderErrorMessage(error: AppleDeviceProviderError): string {
	const details = error.details ?? {};
	const lines = [error.message];

	const hint = details.hint;
	if (typeof hint === "string" && hint.trim()) {
		lines.push(`Hint: ${hint.trim()}`);
	}

	const suggestedCommand = details.suggestedCommand;
	if (typeof suggestedCommand === "string" && suggestedCommand.trim()) {
		lines.push(`Try: ${suggestedCommand.trim()}`);
	}

	const suggestedCommands = details.suggestedCommands;
	if (Array.isArray(suggestedCommands)) {
		for (const entry of suggestedCommands) {
			if (typeof entry !== "string") continue;
			const command = entry.trim();
			if (!command) continue;
			lines.push(`Try: ${command}`);
		}
	}

	return lines.join("\n");
}

function isSimulatorAttachResolution(
	resolution: ReturnType<typeof resolveAppleDeviceAttachTarget>,
): boolean {
	return (
		String(resolution.metadata?.attachEnvironment ?? "").toLowerCase() ===
		"simulator"
	);
}

// ─── Recorder state (visual flight recorder) ───
//
// Recording state lives in the daemon: one recorder per daemon, attached as
// the named session RECORDER_SESSION. Phase 2 (triggers/annotations) hangs
// off this object.

const RECORDER_SESSION = "recorder";

// Phase 2 trigger constants: in-page MutationObserver debounce and the
// Runtime binding it calls; FS quiet period that opens a new auto epoch.
const MUTATION_BINDING = "__dbg_mutation__";
const MUTATION_DEBOUNCE_MS = 300;
const DEFAULT_IDLE_THRESHOLD_MS = 10000;
// Per-path debounce for the `edits` row stream: identical paths firing within
// this window collapse to one row (editors emit several events per save).
const EDIT_DEBOUNCE_MS = 50;

// Injected via Page.addScriptToEvaluateOnNewDocument before the first
// navigation: installs a debounced MutationObserver on documentElement that
// pings the daemon through the registered binding once the DOM settles.
const MUTATION_OBSERVER_SOURCE = `(() => {
	if (window.__dbg_recorder_observer__) return;
	window.__dbg_recorder_observer__ = true;
	let timer = null;
	const fire = () => {
		timer = null;
		try { window.${MUTATION_BINDING}("mutated"); } catch (_e) {}
	};
	const install = () => {
		if (!document.documentElement) { setTimeout(install, 50); return; }
		new MutationObserver(() => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(fire, ${MUTATION_DEBOUNCE_MS});
		}).observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
	};
	install();
})();`;

// Plan X perf flight recorder: binding the injected observer flushes batches
// through, and the source that installs one buffered PerformanceObserver per
// type. Buffered replay needs per-type observe({type,buffered:true}).
const PERF_BINDING = "__dbg_perf__";
const PERF_OBSERVER_SOURCE = `(() => {
	if (window.__dbg_perf_observer__) return;
	window.__dbg_perf_observer__ = true;
	if (typeof PerformanceObserver === 'undefined') return;
	const buf = [];
	const flush = () => {
		if (buf.length === 0) return;
		try { window.${PERF_BINDING}(JSON.stringify(buf.splice(0))); } catch (_e) {}
	};
	const push = (o) => { buf.push(o); if (buf.length >= 20) flush(); };
	const origin = performance.timeOrigin;
	const stamp = (e) => Math.round(origin + e.startTime);
	const observe = (type, opts, map) => {
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					const o = map(entry);
					if (o) push(o);
				}
			}).observe(Object.assign({ type: type, buffered: true }, opts));
		} catch (_e) {}
	};
	observe('largest-contentful-paint', {}, (e) => ({ type: 'largest-contentful-paint', name: e.name || '', ts: stamp(e), value: e.startTime }));
	observe('layout-shift', {}, (e) => e.hadRecentInput ? null : ({ type: 'layout-shift', name: '', ts: stamp(e), value: e.value }));
	observe('longtask', {}, (e) => ({ type: 'longtask', name: e.name || '', ts: stamp(e), value: e.duration }));
	observe('paint', {}, (e) => ({ type: 'paint', name: e.name || '', ts: stamp(e), value: e.startTime }));
	observe('event', { durationThreshold: 40 }, (e) => ({ type: 'event', name: e.name || '', ts: stamp(e), value: e.duration }));
	setInterval(flush, 1000);
	addEventListener('pagehide', flush);
})();`;

const FLOW_BINDING = "__dbg_flow__";
const FLOW_LISTENER_SOURCE = `(() => {
	if (window.__dbg_flow_installed__) return;
	window.__dbg_flow_installed__ = true;
	const cssEscape = (value) => {
		if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
		return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
	};
	const unique = (selector) => {
		try { return document.querySelectorAll(selector).length === 1; } catch (_e) { return false; }
	};
	const nthPath = (el) => {
		const parts = [];
		let cur = el;
		while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
			const tag = cur.tagName.toLowerCase();
			if (cur === document.body) { parts.unshift('body'); break; }
			let n = 1;
			let sib = cur;
			while ((sib = sib.previousElementSibling)) {
				if (sib.tagName === cur.tagName) n++;
			}
			parts.unshift(tag + ':nth-of-type(' + n + ')');
			cur = cur.parentElement;
		}
		return parts.length ? parts.join(' > ') : '';
	};
	const sel = (target) => {
		const el = target && target.nodeType === 1 ? target : target && target.parentElement;
		if (!el || !el.tagName) return { selector: null, fallbackPath: null };
		const fallbackPath = nthPath(el);
		if (el.id) {
			const idSel = '#' + cssEscape(el.id);
			if (unique(idSel)) return { selector: idSel, fallbackPath };
		}
		const testId = el.getAttribute && el.getAttribute('data-testid');
		if (testId) {
			const testSel = '[data-testid="' + String(testId).replace(/"/g, '\\\\"') + '"]';
			if (unique(testSel)) return { selector: testSel, fallbackPath };
		}
		if (el.classList && el.classList.length) {
			const classSel = el.tagName.toLowerCase() + Array.from(el.classList).map((c) => '.' + cssEscape(c)).join('');
			if (unique(classSel)) return { selector: classSel, fallbackPath };
		}
		return { selector: fallbackPath, fallbackPath };
	};
	const send = (action) => {
		try { window.${FLOW_BINDING}(JSON.stringify(action)); } catch (_e) {}
	};
	addEventListener('click', (e) => {
		const s = sel(e.target);
		send({ kind: 'click', selector: s.selector, fallbackPath: s.fallbackPath });
	}, true);
	addEventListener('change', (e) => {
		const s = sel(e.target);
		send({ kind: 'input', selector: s.selector, fallbackPath: s.fallbackPath, value: e.target && 'value' in e.target ? String(e.target.value) : '' });
	}, true);
	addEventListener('keydown', (e) => {
		if (!['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return;
		const s = sel(e.target);
		send({ kind: 'keypress', selector: s.selector, fallbackPath: s.fallbackPath, value: e.key });
	}, true);
	let scrollTimer = null;
	addEventListener('scroll', () => {
		if (scrollTimer !== null) clearTimeout(scrollTimer);
		scrollTimer = setTimeout(() => {
			scrollTimer = null;
			send({ kind: 'scroll', value: String(window.scrollY || 0) });
		}, 250);
	}, true);
})();`;

// Documented Performance.getMetrics subset stored per capture.
const CAPTURE_METRIC_NAMES = new Set([
	"JSHeapUsedSize",
	"JSHeapTotalSize",
	"Nodes",
	"Documents",
	"JSEventListeners",
	"LayoutCount",
	"RecalcStyleCount",
]);

interface RecorderState {
	chrome: LaunchedChrome;
	sessionName: string;
	urls: string[];
	recordingDir: string;
	// ── Phase 2: trigger + annotation state ──
	// FS quiet period (ms) after which the next FS event opens an auto epoch.
	idleThresholdMs: number;
	// devicePixelRatio, evaluated once per navigation (not per capture).
	dpr: number;
	// Hash of the last inserted capture — identical screenshots are skipped.
	lastHash: string | null;
	lastCaptureTs: number | null;
	// Saved files / HMR modules accumulated since the last inserted capture;
	// written to the NEXT capture row, then cleared.
	pendingChangedFiles: Set<string>;
	pendingHmrModules: Set<string>;
	// Latest epoch (auto or named); new capture rows carry this id.
	currentEpochId: number | null;
	lastFsEventTs: number;
	// Per-path timestamp of the last inserted `edits` row; identical paths
	// firing within EDIT_DEBOUNCE_MS collapse to a single row.
	lastEditTs: Map<string, number>;
	watcher: fs.FSWatcher | null;
	// Serializes trigger-driven captures so screenshots never interleave.
	captureChain: Promise<void>;
	// ── Retention (bounded history): budgets enforced after each insert ──
	retention: RetentionConfig;
	// TTL for raw CDP `events` rows; pruned every ~60s and on record.stop.
	eventsTtlMs: number;
	eventsPruneTimer: NodeJS.Timeout | null;
	// ── Plan X: perf flight recorder ──
	// Increments per main-frame navigation observed by the daemon; perf batches
	// and per-capture samples are stamped with the nav_id current at receipt.
	navId: number;
	// requestId → CDP resource type, to attribute loadingFinished bytes.
	resourceTypeById: Map<string, string>;
	// nav_id → cumulative Script/Stylesheet encoded bytes for that navigation.
	navBundleBytes: Map<number, number>;
	// Plan Y: active user-flow recording state.
	flowRecording: { flowId: number; order: number } | null;
}

let recorder: RecorderState | null = null;

// Chrome that has been launched but not yet promoted into `recorder`
// (record.start is still attaching/navigating). Tracked so daemon cleanup
// never orphans it.
let pendingChrome: LaunchedChrome | null = null;

// Throwaway Chrome owned by an in-flight record.shoot. Tracked separately so
// daemon cleanup never orphans it either.
let shootChrome: LaunchedChrome | null = null;

// ─── Lifecycle commands ───

interface OpenPayload {
	port: number;
	host?: string;
	type?: "page" | "node";
	target?: string;
}

async function handleOpen(
	payload: OpenPayload,
	sessionName?: string,
): Promise<Response> {
	const name = sessionName ?? nextSessionName();

	if (registry.sessions.has(name)) {
		return {
			ok: false,
			error: "session already exists; close it first",
		};
	}

	const targetType = payload.type;
	const targetId = payload.target;
	const host = payload.host ?? "127.0.0.1";
	const port = payload.port;

	if (!Number.isFinite(port) || Number.isNaN(port)) {
		return { ok: false, error: "invalid port" };
	}

	const state = createState();
	const cdp = new CdpClientWrapper(state, store);

	try {
		let wsUrl: string;
		let discoveredType: "node" | "page";

		if (targetId) {
			// Direct WebSocket connection to specific target
			wsUrl = `ws://${host}:${port}/devtools/page/${targetId}`;
			discoveredType = targetType ?? "page";
		} else {
			const discovered = await discoverTarget(port, host, targetType);
			wsUrl = discovered.wsUrl;
			discoveredType = discovered.type;
		}

		await cdp.connect(wsUrl, discoveredType);
		if (state.cdp) {
			state.cdp.lastWsUrl = wsUrl;
		}

		const session: Session = {
			name,
			state,
			executor: cdp,
			managedChild: null,
			targetType: discoveredType,
			port,
			host,
		};

		// Store target info for session listing
		if (discoveredType === "page") {
			try {
				const targets = await listTargets(port, host);
				const matching = targets.find((t) => wsUrl.includes(t.id));
				if (matching) {
					session.targetUrl = matching.url;
					session.targetTitle = matching.title;
				}
			} catch {
				// ignore
			}
		}

		registry.sessions.set(name, session);
		registry.current = name;

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			s: name,
			messages: [`connected to ${host}:${port} (${discoveredType})`],
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function handleClose(session: Session): Promise<Response> {
	await (
		session.executor as {
			disconnect?: () => Promise<void>;
		}
	).disconnect?.();
	if (session.managedChild) {
		killTarget(session.managedChild);
		session.managedChild = null;
	}

	// Closing the recorder session directly must not orphan managed Chrome.
	if (recorder && session.name === recorder.sessionName) {
		const chrome = recorder.chrome;
		recorder = null;
		await chrome.kill();
	}

	const prevPid = session.state.pid;
	const sessionName = session.name;
	registry.sessions.delete(sessionName);

	// Update current pointer
	if (registry.current === sessionName) {
		const firstRemaining = registry.sessions.keys().next().value;
		registry.current = firstRemaining ?? null;
	}

	return {
		ok: true,
		messages: [
			prevPid
				? `closed ${sessionName} (pid ${prevPid})`
				: `closed ${sessionName}`,
		],
	};
}

async function handleRun(
	command: string,
	sessionName?: string,
): Promise<Response> {
	const name = sessionName ?? nextSessionName();

	if (registry.sessions.has(name)) {
		return {
			ok: false,
			error: "session already exists; close it first",
		};
	}

	const state = createState();
	const cdp = new CdpClientWrapper(state, store);

	try {
		const { child, port } = await spawnTarget(command);
		state.pid = child.pid ?? null;
		state.managedCommand = command;

		const session: Session = {
			name,
			state,
			executor: cdp,
			managedChild: child,
			targetType: "node",
			port,
			host: "127.0.0.1",
		};

		// Listen for process exit
		child.on("exit", () => {
			session.managedChild = null;
			state.pid = null;
			cdp.disconnect();
		});

		const discovered = await discoverTarget(port);
		await cdp.connect(discovered.wsUrl, discovered.type);
		if (state.cdp) {
			state.cdp.lastWsUrl = discovered.wsUrl;
		}
		session.targetType = discovered.type;

		registry.sessions.set(name, session);
		registry.current = name;

		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			pid: state.pid ?? undefined,
			s: name,
			messages: [`spawned pid=${state.pid}, connected on port ${port}`],
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

interface AttachPayload {
	provider: "apple-device";
	platform: AttachPlatform;
	bundleId: string;
	device?: string;
	pid?: number;
	launch?: boolean;
	attachStrategy?: import("@dbg/types").AttachStrategy;
	attachTimeoutMs?: number;
	verbose?: boolean;
}

async function handleAttach(
	payload: AttachPayload,
	sessionName?: string,
): Promise<Response> {
	const name = sessionName ?? nextSessionName();
	if (registry.sessions.has(name)) {
		return {
			ok: false,
			error: "session already exists; close it first",
		};
	}

	// Validate the payload via the shared schema. parseAttachRequest expects a
	// JSON string; we already have a typed object, so stringify once.
	let request: ReturnType<typeof parseAttachRequest>;
	try {
		request = parseAttachRequest(JSON.stringify(payload));
	} catch (error) {
		return {
			ok: false,
			error: `invalid attach request: ${(error as Error).message}`,
		};
	}
	if (request.protocol && request.protocol !== "dap") {
		return {
			ok: false,
			error: `unsupported attach protocol '${request.protocol}'`,
		};
	}
	const requestedStrategy = request.attachStrategy ?? "auto";

	const state = createState();
	store.record(
		{
			source: "daemon",
			category: "connection",
			method: "apple.attach.start",
			data: request,
		},
		true,
	);

	const providerResolveStartedAt = Date.now();
	let resolution: ReturnType<typeof resolveAppleDeviceAttachTarget>;
	try {
		resolution = resolveAppleDeviceAttachTarget(request);
	} catch (error) {
		const providerResolveMs = Date.now() - providerResolveStartedAt;
		const diagnostics = createEmptyAttachDiagnostics(
			requestedStrategy,
			providerResolveMs,
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.diagnostics",
				data: diagnostics,
			},
			true,
		);
		if (error instanceof AppleDeviceProviderError) {
			store.record(
				{
					source: "daemon",
					category: "connection",
					method: "apple.attach.error",
					data: error.toProviderError(),
				},
				true,
			);
			return {
				ok: false,
				error: formatProviderErrorMessage(error),
				errorCode: error.code,
			};
		}
		return { ok: false, error: (error as Error).message };
	}

	const providerResolveMs = Date.now() - providerResolveStartedAt;

	const staleSession = findSessionByPid(resolution.pid);
	if (staleSession) {
		const diagnostics = createEmptyAttachDiagnostics(
			requestedStrategy,
			providerResolveMs,
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.diagnostics",
				data: diagnostics,
			},
			true,
		);
		const providerError = new AppleDeviceProviderError(
			"invalid_request",
			`pid ${resolution.pid} is already attached in session ${staleSession.name}`,
			{
				session: staleSession.name,
				pid: resolution.pid,
				bundleId: resolution.bundleId,
			},
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.error",
				data: providerError.toProviderError(),
			},
			true,
		);
		return {
			ok: false,
			error: providerError.message,
			errorCode: providerError.code,
		};
	}

	let attempt: Awaited<ReturnType<typeof executeAttachWithStrategy>>;
	try {
		attempt = await executeAttachWithStrategy({
			request,
			resolution,
			state,
			store,
			providerResolveMs,
		});
	} catch (error) {
		const diagnostics = createEmptyAttachDiagnostics(
			requestedStrategy,
			providerResolveMs,
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.diagnostics",
				data: diagnostics,
			},
			true,
		);
		const providerError = new AppleDeviceProviderError(
			"provider_error",
			"attach strategy execution failed unexpectedly",
			{
				originalError: (error as Error).message,
			},
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.error",
				data: providerError.toProviderError(),
			},
			true,
		);
		return {
			ok: false,
			error: providerError.message,
			errorCode: providerError.code,
		};
	}
	store.record(
		{
			source: "daemon",
			category: "connection",
			method: "apple.attach.diagnostics",
			data: attempt.diagnostics,
		},
		true,
	);

	if (!attempt.success) {
		await attempt.dap.disconnect();

		// Auto-retry with --launch for physical devices when launch wasn't requested
		if (!request.launch && !isSimulatorAttachResolution(resolution)) {
			store.record(
				{
					source: "daemon",
					category: "connection",
					method: "apple.attach.auto_retry_launch",
					data: { bundleId: request.bundleId, originalError: attempt.error },
				},
				true,
			);

			const retryRequest = { ...request, launch: true };
			let retryResolution: ReturnType<typeof resolveAppleDeviceAttachTarget>;
			try {
				retryResolution = resolveAppleDeviceAttachTarget(retryRequest);
			} catch (retryError) {
				return {
					ok: false,
					error: `auto-retry with --launch failed during resolve: ${(retryError as Error).message}`,
					phase: state.dap?.phase,
				};
			}

			const retryState = createState();
			let retryAttempt: Awaited<ReturnType<typeof executeAttachWithStrategy>>;
			try {
				retryAttempt = await executeAttachWithStrategy({
					request: retryRequest,
					resolution: retryResolution,
					state: retryState,
					store,
					providerResolveMs: 0,
				});
			} catch (retryError) {
				return {
					ok: false,
					error: `auto-retry with --launch failed: ${(retryError as Error).message}`,
					phase: retryState.dap?.phase,
				};
			}

			if (retryAttempt.success) {
				return createAttachSession(
					name,
					retryRequest,
					retryResolution,
					retryAttempt,
					retryState,
					["auto-retried with --launch for debuggable session"],
				);
			}
			await retryAttempt.dap.disconnect();
		}

		const providerError = new AppleDeviceProviderError(
			"attach_denied_or_timeout",
			"attach failed before debugger reached a debuggable stopped state",
			{
				hint: isSimulatorAttachResolution(resolution)
					? "Ensure the Simulator is booted, the app is running, and the process is attachable."
					: "Physical devices require --launch for a debuggable session. Retry with: dbg attach <bundleId> --launch",
				originalError: attempt.error,
				diagnostics: attempt.diagnostics,
			},
		);
		store.record(
			{
				source: "daemon",
				category: "connection",
				method: "apple.attach.error",
				data: providerError.toProviderError(),
			},
			true,
		);
		return {
			ok: false,
			error: `${providerError.message}. Last error: ${attempt.error ?? "unknown"}`,
			errorCode: providerError.code,
			phase: state.dap?.phase,
		};
	}

	return createAttachSession(name, request, resolution, attempt, state, []);
}

async function createAttachSession(
	name: string,
	request: ReturnType<typeof parseAttachRequest>,
	resolution: ReturnType<typeof resolveAppleDeviceAttachTarget>,
	attempt: Awaited<ReturnType<typeof executeAttachWithStrategy>>,
	state: ReturnType<typeof createState>,
	extraMessages: string[],
): Promise<Response> {
	const session: Session = {
		name,
		state,
		executor: attempt.dap,
		managedChild: null,
		targetType: "native",
		port: 0,
		host: resolution.deviceId,
		targetTitle: resolution.bundleId,
	};
	registry.sessions.set(name, session);
	registry.current = name;

	store.record(
		{
			source: "daemon",
			category: "connection",
			method: "apple.attach.success",
			data: {
				deviceId: resolution.deviceId,
				bundleId: resolution.bundleId,
				pid: resolution.pid,
				strategy: attempt.strategy,
				diagnostics: attempt.diagnostics,
			},
		},
		true,
	);

	const messages = [
		...extraMessages,
		`attached ${resolution.bundleId} on ${resolution.deviceId} (pid ${resolution.pid})`,
	];
	if (request.verbose) {
		messages.push(...formatAttachDiagnostics(attempt.diagnostics));
	}

	// Auto-continue past dyld to app code on --launch physical device attach
	if (request.launch && !isSimulatorAttachResolution(resolution)) {
		try {
			const continueResult = await attempt.dap.continueToMain();
			if (continueResult.hitMain && continueResult.location) {
				messages.push(
					`continued to ${continueResult.location.function} at ${continueResult.location.file}:${continueResult.location.line}`,
				);
			} else {
				messages.push("could not auto-continue to main; paused in dyld");
			}
		} catch {
			messages.push("could not auto-continue to main; paused in dyld");
		}
	}

	return {
		ok: true,
		connected: true,
		status: state.paused ? "paused" : "running",
		pid: resolution.pid,
		s: name,
		messages,
	};
}

async function handleAttachLldb(
	programPath: string,
	programArgs: string[] | undefined,
	sessionName?: string,
): Promise<Response> {
	const name = sessionName ?? nextSessionName();
	if (registry.sessions.has(name)) {
		return {
			ok: false,
			error: "session already exists; close it first",
		};
	}

	if (!programPath) {
		return { ok: false, error: "usage: attach-lldb <program-path>" };
	}

	const state = createState();
	const dap = new DapClientWrapper(state, store);
	try {
		await dap.attachLldb({
			programPath,
			args: programArgs ?? [],
		});

		const session: Session = {
			name,
			state,
			executor: dap,
			managedChild: null,
			targetType: "native",
			port: 0,
			host: "localhost",
			targetTitle: programPath,
		};
		registry.sessions.set(name, session);
		registry.current = name;
		return {
			ok: true,
			connected: true,
			status: state.paused ? "paused" : "running",
			phase: state.dap?.phase,
			s: name,
			messages: [`attached lldb to ${programPath}`],
		};
	} catch (error) {
		await dap.disconnect();
		return {
			ok: false,
			error: (error as Error).message,
			errorCode: parseErrorCode(error),
			phase: state.dap?.phase,
		};
	}
}

async function handleRestart(session: Session): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "restart is only supported for cdp sessions" };
	}
	if (!session.state.managedCommand) {
		return { ok: false, error: "no managed process to restart" };
	}

	const command = session.state.managedCommand;
	const savedBreakpoints = Array.from(session.state.breakpoints.values());

	// Disconnect and kill
	await cdp.disconnect();
	if (session.managedChild) {
		killTarget(session.managedChild);
		session.managedChild = null;
	}

	// Reset state but remember the command
	session.state = createState();
	session.state.managedCommand = command;
	session.executor = new CdpClientWrapper(session.state, store);
	const nextCdp = asCdpExecutor(session);
	if (!nextCdp) {
		return { ok: false, error: "failed to initialize cdp executor" };
	}

	// Respawn
	try {
		const { child, port } = await spawnTarget(command);
		session.managedChild = child;
		session.state.pid = child.pid ?? null;
		session.port = port;

		child.on("exit", () => {
			session.managedChild = null;
			session.state.pid = null;
			void nextCdp.disconnect();
		});

		const discovered = await discoverTarget(port);
		await nextCdp.connect(discovered.wsUrl, discovered.type);
		if (session.state.cdp) {
			session.state.cdp.lastWsUrl = discovered.wsUrl;
		}
		session.targetType = discovered.type;

		// Re-apply breakpoints using setBreakpointByUrl so they auto-apply
		// when matching scripts load (we're paused at line 0, scripts not loaded yet)
		const restored: string[] = [];
		for (const bp of savedBreakpoints) {
			try {
				const urlRegex = `.*${bp.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
				const result = (await nextCdp.send("Debugger.setBreakpointByUrl", {
					lineNumber: bp.line,
					urlRegex,
					columnNumber: 0,
					...(bp.condition ? { condition: bp.condition } : {}),
				})) as {
					breakpointId: string;
					locations: Array<{
						scriptId: string;
						lineNumber: number;
						columnNumber: number;
					}>;
				};
				const newBp: StoredBreakpoint = {
					id: result.breakpointId,
					file: bp.file,
					line: result.locations[0]?.lineNumber ?? bp.line,
					condition: bp.condition,
					hits: 0,
					enabled: true,
					cdpBreakpointId: result.breakpointId,
				};
				session.state.breakpoints.set(result.breakpointId, newBp);
				restored.push(result.breakpointId);
			} catch {
				// Skip breakpoints that can't be restored
			}
		}

		return {
			ok: true,
			connected: true,
			status: session.state.paused ? "paused" : "running",
			pid: session.state.pid ?? undefined,
			s: session.name,
			messages: [
				`restarted pid=${session.state.pid}`,
				`restored ${restored.length}/${savedBreakpoints.length} breakpoints`,
			],
		};
	} catch (e) {
		return { ok: false, error: `restart failed: ${(e as Error).message}` };
	}
}

// ─── Recording commands ───

async function waitForPageLoad(
	cdp: CdpClientWrapper,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const result = (await cdp.send("Runtime.evaluate", {
				expression: "document.readyState",
				returnByValue: true,
			})) as { result?: { value?: unknown } };
			if (result.result?.value === "complete") return;
		} catch {
			// evaluate can fail mid-navigation — keep polling
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	// Best-effort: capture whatever is rendered after the timeout.
}

/** Capture a screenshot and insert a captures row. Returns null when the
 * screenshot is pixel-identical to the previous capture (hash dedupe) — in
 * that case pending annotations stay queued for the next distinct capture. */
// ── Plan V: per-capture app-state + accessibility collection ──
// Both are best-effort (never fail a capture) and stored as metadata rows
// (kept; retention/TTL never prune them), keyed to the capture id.

/** Dump local/sessionStorage via a one-shot eval → state_snapshots rows. */
async function collectCaptureState(
	cdp: CdpClientWrapper,
	captureId: number,
): Promise<void> {
	try {
		const res = (await cdp.send("Runtime.evaluate", {
			expression:
				"JSON.stringify({local:Object.assign({},window.localStorage),session:Object.assign({},window.sessionStorage)})",
			returnByValue: true,
		})) as { result?: { value?: string } };
		const raw = res.result?.value;
		if (typeof raw !== "string") return;
		const parsed = JSON.parse(raw) as {
			local?: Record<string, string>;
			session?: Record<string, string>;
		};
		store.insertStateSnapshot({
			captureId,
			kind: "localStorage",
			data: JSON.stringify(parsed.local ?? {}),
		});
		store.insertStateSnapshot({
			captureId,
			kind: "sessionStorage",
			data: JSON.stringify(parsed.session ?? {}),
		});
	} catch {
		// storage unavailable (sandboxed/opaque origin) — skip
	}
}

/** Fetch the AX tree once → gzipped, content-addressed blob (retention-managed
 * like DOM snapshots) + the parsed tree for rule evaluation. Null on failure. */
async function captureAxBlob(
	cdp: CdpClientWrapper,
	blobsDir: string,
): Promise<{ axPath: string; tree: AxTree } | null> {
	try {
		const tree = (await cdp.send("Accessibility.getFullAXTree", {})) as AxTree;
		if (!Array.isArray(tree.nodes) || tree.nodes.length === 0) return null;
		const json = JSON.stringify(tree);
		const axHash = createHash("sha256").update(json).digest("hex").slice(0, 16);
		const axPath = path.join(blobsDir, `${axHash}-ax.json.gz`);
		if (!fs.existsSync(axPath)) fs.writeFileSync(axPath, gzipSync(json));
		return { axPath, tree };
	} catch {
		// Accessibility domain unavailable — skip
		return null;
	}
}

/** Compute the 5 a11y rules from a captured tree → a11y_issues rows. */
function storeA11yIssues(captureId: number, tree: AxTree): void {
	const issues = computeA11yIssues(tree);
	if (issues.length > 0) {
		store.insertA11yIssues(
			issues.map((i) => ({
				captureId,
				rule: i.rule,
				selector: i.selector,
				detail: i.detail,
			})),
		);
	}
}

/** Plan X: best-effort Performance.getMetrics subset → perf_samples rows for a
 * capture. One CDP call, swallowed on failure; never breaks a capture. */
async function sampleCaptureMetrics(
	cdp: CdpClientWrapper,
	captureId: number,
	navId: number,
	ts: number,
): Promise<void> {
	try {
		const res = (await cdp.send("Performance.getMetrics", {})) as {
			metrics?: Array<{ name: string; value: number }>;
		};
		const rows: PerfSampleRow[] = [];
		for (const m of res.metrics ?? []) {
			if (!CAPTURE_METRIC_NAMES.has(m.name)) continue;
			if (!Number.isFinite(m.value)) continue;
			rows.push({
				ts,
				navId,
				captureId,
				metric: m.name,
				value: m.value,
				detail: null,
			});
		}
		if (rows.length > 0) store.insertPerfSamples(rows);
	} catch {
		// Performance domain unavailable — skip
	}
}

/** Load a capture's stored storage snapshot (both kinds) for state diffing. */
function loadStorageSnapshot(captureId: number): StorageSnapshot {
	const snap: StorageSnapshot = { localStorage: {}, sessionStorage: {} };
	for (const row of store.query(
		"SELECT kind, data FROM state_snapshots WHERE capture_id = ?",
		[captureId],
	)) {
		let parsed: Record<string, string>;
		try {
			parsed = JSON.parse(String(row.data ?? "{}"));
		} catch {
			parsed = {};
		}
		if (row.kind === "localStorage") snap.localStorage = parsed;
		else if (row.kind === "sessionStorage") snap.sessionStorage = parsed;
	}
	return snap;
}

/** Load a capture's computed a11y issues. */
function loadA11yIssues(
	captureId: number,
): Array<{ rule: string; selector: string; detail: string }> {
	return store
		.query(
			"SELECT rule, selector, detail FROM a11y_issues WHERE capture_id = ?",
			[captureId],
		)
		.map((row) => ({
			rule: String(row.rule),
			selector: String(row.selector),
			detail: String(row.detail),
		}));
}

async function captureRecorderFrame(
	session: Session,
	recordingDir: string,
	opts?: { force?: boolean },
): Promise<{
	id: number;
	pngPath: string;
	hash: string;
	snapshotPath: string | null;
} | null> {
	const cdp = asCdpExecutor(session);
	if (!cdp) throw new Error("recorder session is not a cdp session");

	const shot = (await cdp.send("Page.captureScreenshot", {
		format: "png",
	})) as { data: string };
	const buffer = Buffer.from(shot.data, "base64");
	const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);

	if (!opts?.force && recorder && recorder.lastHash === hash) return null;

	const ts = Date.now();
	// Content-addressed blob store: identical frames (force-captures of
	// unchanged pixels, reload dupes) share one blob — zero new bytes.
	const blobsDir = path.join(recordingDir, "blobs");
	fs.mkdirSync(blobsDir, { recursive: true });
	const pngPath = path.join(blobsDir, `${hash}.png`);
	if (!fs.existsSync(pngPath)) {
		fs.writeFileSync(pngPath, buffer);
	}

	// DOM/style/component snapshot (Phase 4 blame + style-diff input) —
	// best-effort; a capture without a snapshot is still a capture. Keyed by
	// its own content hash: an unchanged DOM re-references the same blob.
	let snapshotPath: string | null = null;
	try {
		const snapshot = await capturePageSnapshot(cdp);
		if (snapshot.elements.length > 0 || snapshot.components.length > 0) {
			const json = JSON.stringify(snapshot);
			const snapshotHash = createHash("sha256")
				.update(json)
				.digest("hex")
				.slice(0, 16);
			snapshotPath = path.join(blobsDir, `${snapshotHash}-snapshot.json.gz`);
			if (!fs.existsSync(snapshotPath)) {
				fs.writeFileSync(snapshotPath, gzipSync(json));
			}
		}
	} catch {
		// never fail the capture over its snapshot
	}

	// Plan V: accessibility tree → gzipped, content-addressed, retention-managed
	// blob; the parsed tree feeds the a11y rules after the row is inserted.
	const ax = await captureAxBlob(cdp, blobsDir);

	let url = session.targetUrl ?? "";
	let scrollY = 0;
	try {
		const result = (await cdp.send("Runtime.evaluate", {
			expression:
				"JSON.stringify({url: location.href, scrollY: window.scrollY})",
			returnByValue: true,
		})) as { result?: { value?: string } };
		if (result.result?.value) {
			const metrics = JSON.parse(result.result.value) as {
				url: string;
				scrollY: number;
			};
			url = metrics.url;
			scrollY = metrics.scrollY;
		}
	} catch {
		// metadata is best-effort; the frame itself is what matters
	}

	const id = store.insertCapture({
		ts,
		sessionId: session.name,
		url,
		scrollY,
		// dpr is evaluated once per navigation and cached on the recorder.
		dpr: recorder?.dpr ?? 1,
		hash,
		pngPath,
		changedFiles: recorder ? [...recorder.pendingChangedFiles] : [],
		hmrModules: recorder ? [...recorder.pendingHmrModules] : [],
		epochId: recorder?.currentEpochId ?? null,
		snapshotPath,
		axPath: ax?.axPath ?? null,
	});
	// Plan V: per-capture app-state + a11y metadata (best-effort).
	await collectCaptureState(cdp, id);
	if (ax) storeA11yIssues(id, ax.tree);
	// Plan X: per-capture perf metrics + running per-nav bundle-bytes snapshot.
	{
		const navId = recorder?.navId ?? 1;
		await sampleCaptureMetrics(cdp, id, navId, ts);
		if (recorder) {
			store.insertPerfSamples([
				{
					ts,
					navId,
					captureId: id,
					metric: "bundle_bytes",
					value: recorder.navBundleBytes.get(navId) ?? 0,
					detail: null,
				},
			]);
		}
	}
	if (recorder) {
		recorder.lastHash = hash;
		recorder.lastCaptureTs = ts;
		recorder.pendingChangedFiles.clear();
		recorder.pendingHmrModules.clear();
		// Enforce retention budgets after every insert (cheap under budget).
		try {
			applyRetention(store, session.name, recordingDir, recorder.retention);
		} catch {
			// retention must never fail a capture
		}
	}
	return { id, pngPath, hash, snapshotPath };
}

/** Read a capture's gzipped PageSnapshot from disk; null when absent/corrupt. */
function loadPageSnapshot(snapshotPath?: string | null): PageSnapshot | null {
	if (!snapshotPath) return null;
	try {
		const parsed = JSON.parse(
			gunzipSync(fs.readFileSync(snapshotPath)).toString("utf8"),
		) as PageSnapshot;
		return Array.isArray(parsed.elements) && Array.isArray(parsed.components)
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** Evaluate the page's devicePixelRatio (once per navigation). */
async function evaluateRecorderDpr(cdp: CdpClientWrapper): Promise<number> {
	try {
		const result = (await cdp.send("Runtime.evaluate", {
			expression: "window.devicePixelRatio",
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		const dpr = Number(result.result?.value);
		return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	} catch {
		return 1;
	}
}

/** Queue a trigger-driven capture on the recorder's serial chain. This is
 * also the Phase 3 hook for forcing a capture on demand. */
function triggerRecorderCapture(_reason: string): Promise<void> {
	const r = recorder;
	if (!r) return Promise.resolve();
	const run = async () => {
		// Recording may have stopped (or restarted) while queued.
		if (recorder !== r) return;
		const session = registry.sessions.get(r.sessionName);
		if (!session) return;
		try {
			await captureRecorderFrame(session, r.recordingDir);
		} catch {
			// best-effort: the page may be mid-navigation
		}
	};
	r.captureChain = r.captureChain.then(run, run);
	return r.captureChain;
}

/** Force a capture on demand (bypasses hash dedupe), serialized on the
 * capture chain. Used by record.after; Phase 4+ can reuse it. */
async function forceRecorderCapture(
	session: Session,
): Promise<Awaited<ReturnType<typeof captureRecorderFrame>>> {
	const r = recorder;
	if (!r) return null;
	let out: Awaited<ReturnType<typeof captureRecorderFrame>> = null;
	const run = async () => {
		if (recorder !== r) return;
		out = await captureRecorderFrame(session, r.recordingDir, { force: true });
	};
	const chained = r.captureChain.then(run, run);
	r.captureChain = chained.catch(() => {});
	await chained;
	return out;
}

/** Main-frame navigation: wait for load, refresh cached dpr, capture. */
async function onRecorderNavigated(): Promise<void> {
	const r = recorder;
	if (!r) return;
	const session = registry.sessions.get(r.sessionName);
	const cdp = session ? asCdpExecutor(session) : null;
	if (!cdp) return;
	await waitForPageLoad(cdp, 10000);
	if (recorder !== r) return;
	r.dpr = await evaluateRecorderDpr(cdp);
	await triggerRecorderCapture("navigated");
}

function recorderFrameCount(sessionName: string): number {
	const rows = store.query(
		"SELECT COUNT(*) AS c FROM captures WHERE session_id = ?",
		[sessionName],
	);
	return Number(rows[0]?.c ?? 0);
}

function recorderEpochCount(sessionName: string): number {
	const rows = store.query(
		"SELECT COUNT(*) AS c FROM epochs WHERE session_id = ?",
		[sessionName],
	);
	return Number(rows[0]?.c ?? 0);
}

function recorderEventsRows(): number {
	const rows = store.query("SELECT COUNT(*) AS c FROM events");
	return Number(rows[0]?.c ?? 0);
}

function recorderLastCaptureTs(sessionName: string): number | null {
	const rows = store.query(
		"SELECT MAX(ts) AS t FROM captures WHERE session_id = ?",
		[sessionName],
	);
	const t = rows[0]?.t;
	return t == null ? null : Number(t);
}

/** Positive-integer env override, e.g. DBG_MAX_FRAMES=3 for tests. */
function envInt(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function handleRecordStart(
	urls: string[],
	viewport?: { width: number; height: number },
	idleThresholdMs?: number,
	limits?: { maxFrames?: number; maxBytes?: number; eventsTtlMs?: number },
): Promise<Response> {
	if (recorder) {
		return {
			ok: false,
			error: "recording already running; stop it first (dbg record --stop)",
		};
	}
	if (urls.length === 0 || !urls[0]) {
		return { ok: false, error: "usage: record <url>" };
	}
	if (registry.sessions.has(RECORDER_SESSION)) {
		return {
			ok: false,
			error: `session "${RECORDER_SESSION}" already exists; close it first`,
		};
	}

	let chrome: LaunchedChrome;
	try {
		// $DBG_CHROME_PROFILE isolates concurrent recorders (used by tests to
		// avoid SingletonLock collisions on the shared default profile).
		chrome = await launchChrome(
			process.env.DBG_CHROME_PROFILE
				? { profileDir: process.env.DBG_CHROME_PROFILE }
				: {},
		);
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	pendingChrome = chrome;

	try {
		const state = createState();
		const cdp = new CdpClientWrapper(state, store);
		// The page target can lag DevToolsActivePort by a moment — retry briefly.
		const discoveryDeadline = Date.now() + 5000;
		let discovered: Awaited<ReturnType<typeof discoverTarget>>;
		for (;;) {
			try {
				discovered = await discoverTarget(chrome.port, "127.0.0.1", "page");
				break;
			} catch (e) {
				if (Date.now() >= discoveryDeadline) throw e;
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		await cdp.connect(discovered.wsUrl, "page");
		if (state.cdp) {
			state.cdp.lastWsUrl = discovered.wsUrl;
		}

		const session: Session = {
			name: RECORDER_SESSION,
			state,
			executor: cdp,
			managedChild: null,
			targetType: "page",
			port: chrome.port,
			host: "127.0.0.1",
			targetUrl: urls[0],
		};
		registry.sessions.set(RECORDER_SESSION, session);
		registry.current = RECORDER_SESSION;

		if (viewport) {
			await cdp.send("Emulation.setDeviceMetricsOverride", {
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: 1,
				mobile: false,
			});
		}

		// ── Phase 2 triggers: mutation binding, navigation, HMR wire-tap ──
		// Installed before the first navigation so the injected observer runs
		// in every document from the start.
		await cdp.send("Runtime.addBinding", { name: MUTATION_BINDING });
		await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
			source: MUTATION_OBSERVER_SOURCE,
		});
		// Plan X: buffered PerformanceObserver → __dbg_perf__ binding batches.
		try {
			await cdp.send("Runtime.addBinding", { name: PERF_BINDING });
			await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
				source: PERF_OBSERVER_SOURCE,
			});
		} catch {
			// non-fatal: perf samples simply won't be collected
		}
		try {
			await cdp.send("Runtime.addBinding", { name: FLOW_BINDING });
			await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
				source: FLOW_LISTENER_SOURCE,
			});
		} catch {
			// non-fatal until a flow recording is explicitly started
		}
		// Plan V: accessibility tree access for per-capture a11y issues.
		try {
			await cdp.send("Accessibility.enable", {});
		} catch {
			// non-fatal: a11y issues simply won't be collected
		}
		const rawClient = cdp.getClient();
		rawClient?.on("Runtime.bindingCalled", (params: unknown) => {
			const p = params as { name?: string; payload?: string };
			if (p.name === MUTATION_BINDING) {
				void triggerRecorderCapture("mutation");
				return;
			}
			if (p.name === PERF_BINDING) {
				const r = recorder;
				if (!r) return;
				try {
					const rows = parsePerfBatch(p.payload ?? "", r.navId);
					if (rows.length > 0) store.insertPerfSamples(rows);
				} catch {
					// perf ingestion is best-effort
				}
				return;
			}
			if (p.name === FLOW_BINDING) {
				const r = recorder;
				if (!r?.flowRecording) return;
				const action = parseFlowAction(p.payload ?? "");
				if (!action) return;
				store.insertFlowStep({
					flowId: r.flowRecording.flowId,
					idx: r.flowRecording.order++,
					kind: action.kind,
					selector: action.selector,
					fallbackPath: action.fallbackPath,
					value: action.value,
					detail: null,
				});
			}
		});
		rawClient?.on("Page.frameNavigated", (params: unknown) => {
			const p = params as { frame?: { parentId?: string; url?: string } };
			if (!p.frame) return;
			if (p.frame?.parentId) return; // main frame only
			// Plan X: bump nav_id at nav so post-nav perf entries get the new id.
			if (recorder) {
				recorder.navId += 1;
				if (recorder.flowRecording && p.frame.url) {
					store.insertFlowStep({
						flowId: recorder.flowRecording.flowId,
						idx: recorder.flowRecording.order++,
						kind: "nav",
						selector: null,
						fallbackPath: null,
						value: p.frame.url,
						detail: null,
					});
				}
			}
			void onRecorderNavigated();
		});
		rawClient?.on("Network.webSocketFrameReceived", (params: unknown) => {
			const r = recorder;
			if (!r) return;
			const p = params as { response?: { payloadData?: string } };
			for (const mod of parseHmrModules(p.response?.payloadData ?? "")) {
				r.pendingHmrModules.add(mod);
			}
		});
		// Plan X: track Script/Stylesheet encoded bytes per nav (do not rely on
		// TTL-pruned events); materialized into a bundle_bytes row per capture.
		rawClient?.on("Network.responseReceived", (params: unknown) => {
			const r = recorder;
			if (!r) return;
			const p = params as { requestId?: string; type?: string };
			if (typeof p.requestId === "string" && typeof p.type === "string") {
				r.resourceTypeById.set(p.requestId, p.type);
			}
		});
		rawClient?.on("Network.loadingFinished", (params: unknown) => {
			const r = recorder;
			if (!r) return;
			const p = params as { requestId?: string; encodedDataLength?: number };
			const type = p.requestId
				? r.resourceTypeById.get(p.requestId)
				: undefined;
			if (type === "Script" || type === "Stylesheet") {
				const prev = r.navBundleBytes.get(r.navId) ?? 0;
				r.navBundleBytes.set(r.navId, prev + (p.encodedDataLength ?? 0));
			}
		});

		const nav = (await cdp.send("Page.navigate", { url: urls[0] })) as {
			errorText?: string;
		};
		if (nav.errorText) {
			throw new Error(`navigation failed: ${nav.errorText}`);
		}
		await waitForPageLoad(cdp, 10000);

		const recordingDir = path.join(
			process.cwd(),
			".dbg",
			"recordings",
			RECORDER_SESSION,
		);
		recorder = {
			chrome,
			sessionName: RECORDER_SESSION,
			urls,
			recordingDir,
			idleThresholdMs: idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
			dpr: 1,
			lastHash: null,
			lastCaptureTs: null,
			pendingChangedFiles: new Set(),
			pendingHmrModules: new Set(),
			currentEpochId: null,
			lastFsEventTs: Date.now(),
			lastEditTs: new Map(),
			watcher: null,
			captureChain: Promise.resolve(),
			retention: {
				maxFullFrames:
					limits?.maxFrames ??
					envInt("DBG_MAX_FRAMES") ??
					DEFAULT_MAX_FULL_FRAMES,
				maxBytes:
					limits?.maxBytes ?? envInt("DBG_MAX_BYTES") ?? DEFAULT_MAX_BYTES,
			},
			eventsTtlMs:
				limits?.eventsTtlMs ??
				envInt("DBG_EVENTS_TTL_MS") ??
				DEFAULT_EVENTS_TTL_MS,
			eventsPruneTimer: null,
			navId: 1,
			resourceTypeById: new Map(),
			navBundleBytes: new Map(),
			flowRecording: null,
		};
		pendingChrome = null;

		// Raw CDP events grow ~556KB/min while recording — prune on a timer.
		{
			const r = recorder;
			r.eventsPruneTimer = setInterval(() => {
				if (recorder !== r) return;
				try {
					store.pruneEvents(r.eventsTtlMs);
				} catch {
					// pruning must never break recording
				}
			}, 60_000);
			if (r.eventsPruneTimer.unref) r.eventsPruneTimer.unref();
		}

		recorder.dpr = await evaluateRecorderDpr(cdp);

		// Recursive FS watch on the recording cwd: saved files annotate the
		// next capture; a save after >= idleThresholdMs of FS quiet opens a
		// new auto epoch (inserted before the file accumulates).
		try {
			recorder.watcher = fs.watch(
				process.cwd(),
				{ recursive: true },
				(_eventType, filename) => {
					const r = recorder;
					if (!r || typeof filename !== "string" || filename.length === 0)
						return;
					if (isIgnoredWatchPath(filename)) return;
					const now = Date.now();
					if (now - r.lastFsEventTs >= r.idleThresholdMs) {
						r.currentEpochId = store.insertEpoch({
							ts: now,
							sessionId: r.sessionName,
							auto: true,
						});
					}
					r.lastFsEventTs = now;
					r.pendingChangedFiles.add(filename);
					// First-class edit stream: one row per fs event, tagged with
					// the current epoch. Debounce identical paths within a short
					// window (editors fire multiple events per save).
					if (now - (r.lastEditTs.get(filename) ?? 0) >= EDIT_DEBOUNCE_MS) {
						r.lastEditTs.set(filename, now);
						store.insertEdit({
							ts: now,
							path: filename,
							epochId: r.currentEpochId,
							sessionId: r.sessionName,
						});
					}
				},
			);
		} catch {
			// fs.watch can fail on exotic filesystems; record without annotations
		}

		const frame = await captureRecorderFrame(session, recordingDir);

		store.record(
			{
				source: "daemon",
				category: "recording",
				method: "record.start",
				data: { urls, pid: chrome.pid, port: chrome.port },
				sessionId: RECORDER_SESSION,
			},
			true,
		);

		return {
			ok: true,
			s: RECORDER_SESSION,
			pid: chrome.pid,
			messages: [
				`recording ${urls[0]} (chrome pid ${chrome.pid}, port ${chrome.port})`,
				frame
					? `frame ${frame.id} saved to ${frame.pngPath}`
					: "initial frame deduped",
			],
			recording: {
				running: true,
				pid: chrome.pid,
				port: chrome.port,
				urls,
				frameCount: recorderFrameCount(RECORDER_SESSION),
				session: RECORDER_SESSION,
			},
		};
	} catch (e) {
		recorder?.watcher?.close();
		if (recorder?.eventsPruneTimer) clearInterval(recorder.eventsPruneTimer);
		recorder = null;
		pendingChrome = null;
		const stale = registry.sessions.get(RECORDER_SESSION);
		if (stale) {
			await handleClose(stale);
		}
		await chrome.kill();
		return { ok: false, error: (e as Error).message };
	}
}

async function handleRecordStop(): Promise<Response> {
	if (!recorder) {
		return {
			ok: true,
			messages: ["no recording in progress"],
			recording: { running: false },
		};
	}

	const { chrome, sessionName, watcher, eventsPruneTimer, eventsTtlMs } =
		recorder;
	recorder = null;
	watcher?.close();
	if (eventsPruneTimer) clearInterval(eventsPruneTimer);
	try {
		store.pruneEvents(eventsTtlMs);
	} catch {
		// best-effort final prune
	}

	const session = registry.sessions.get(sessionName);
	if (session) {
		await handleClose(session);
	}
	await chrome.kill();

	store.record(
		{
			source: "daemon",
			category: "recording",
			method: "record.stop",
			data: { pid: chrome.pid },
			sessionId: sessionName,
		},
		true,
	);

	return {
		ok: true,
		messages: [`recording stopped (chrome pid ${chrome.pid} killed)`],
		recording: { running: false },
	};
}

async function handleRecordMark(name?: string): Promise<Response> {
	if (!recorder) {
		return {
			ok: false,
			error: "no recording in progress (dbg record <url> first)",
		};
	}
	const ts = Date.now();
	const id = store.insertEpoch({
		ts,
		sessionId: recorder.sessionName,
		name: name ?? null,
		auto: false,
	});
	recorder.currentEpochId = id;
	store.record(
		{
			source: "daemon",
			category: "recording",
			method: "record.mark",
			data: { id, name: name ?? null },
			sessionId: recorder.sessionName,
		},
		true,
	);
	return {
		ok: true,
		messages: [`epoch ${id}${name ? ` "${name}"` : ""} marked`],
	};
}

async function handleRecordStatus(): Promise<Response> {
	if (!recorder) {
		const stats = sessionRetentionStats(store, RECORDER_SESSION);
		return {
			ok: true,
			recording: {
				running: false,
				frameCount: recorderFrameCount(RECORDER_SESSION),
				captureCount: recorderFrameCount(RECORDER_SESSION),
				epochCount: recorderEpochCount(RECORDER_SESSION),
				lastCaptureTs: recorderLastCaptureTs(RECORDER_SESSION),
				diskBytes: stats.diskBytes,
				fullFrames: stats.fullFrames,
				thumbFrames: stats.thumbFrames,
				metaFrames: stats.metaFrames,
				eventsRows: recorderEventsRows(),
			},
		};
	}
	const captureCount = recorderFrameCount(recorder.sessionName);
	const stats = sessionRetentionStats(store, recorder.sessionName);
	return {
		ok: true,
		recording: {
			running: true,
			pid: recorder.chrome.pid,
			port: recorder.chrome.port,
			urls: recorder.urls,
			frameCount: captureCount,
			captureCount,
			epochCount: recorderEpochCount(recorder.sessionName),
			lastCaptureTs:
				recorder.lastCaptureTs ?? recorderLastCaptureTs(recorder.sessionName),
			session: recorder.sessionName,
			diskBytes: stats.diskBytes,
			fullFrames: stats.fullFrames,
			thumbFrames: stats.thumbFrames,
			metaFrames: stats.metaFrames,
			eventsRows: recorderEventsRows(),
		},
	};
}

// ─── record.after / record.timeline / record.replay (Phase 3) ───

function recorderCaptureRows(sessionName: string): AnchorCaptureRow[] {
	return store
		.query(
			`SELECT id, ts, url, scroll_y, png_path, changed_files, snapshot_path, tier
			 FROM captures WHERE session_id = ? ORDER BY id`,
			[sessionName],
		)
		.map((row) => ({
			id: Number(row.id),
			ts: Number(row.ts),
			url: String(row.url ?? ""),
			scrollY: Number(row.scroll_y ?? 0),
			pngPath: String(row.png_path ?? ""),
			changedFiles: safeJsonArray(row.changed_files),
			snapshotPath:
				row.snapshot_path == null ? null : String(row.snapshot_path),
			tier: String(row.tier ?? "full"),
		}));
}

function recorderEpochRows(sessionName: string): AnchorEpochRow[] {
	return store
		.query("SELECT id, ts, name FROM epochs WHERE session_id = ? ORDER BY id", [
			sessionName,
		])
		.map((row) => ({
			id: Number(row.id),
			ts: Number(row.ts),
			name: row.name == null ? null : String(row.name),
		}));
}

function safeJsonArray(value: unknown): string[] {
	try {
		const parsed = JSON.parse(String(value ?? "[]")) as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** Console/exception entries newer than anchorTs, deduped by type+text
 * (Chrome reports console.error via both Runtime and Log domains). */
function consoleDeltaSince(
	session: Session,
	anchorTs: number,
): { errors: Array<{ type: string; text: string; ts: number }> } {
	const seen = new Set<string>();
	const errors: Array<{ type: string; text: string; ts: number }> = [];
	for (const entry of session.state.console) {
		if (entry.ts <= anchorTs) continue;
		if (entry.type !== "error" && entry.type !== "assert") continue;
		// Defensive: tap sentinels are already suppressed at the adapter choke
		// (never reach state.console) and are type 'log' anyway — but never let a
		// `__dbg_tap:` row leak into the user-facing console delta.
		if (entry.text.startsWith("__dbg_tap:")) continue;
		const key = `${entry.type}|${entry.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		errors.push({ type: entry.type, text: entry.text, ts: entry.ts });
	}
	return { errors };
}

/** New network failures since anchorTs, read from recorded CDP events:
 * loadingFailed (any) and responseReceived with status >= 400. */
function networkDeltaSince(anchorTs: number): Array<{
	url: string;
	ts: number;
	method?: string;
	status?: number;
	error?: string;
}> {
	const rows = store.query(
		`SELECT ts, method, data FROM events
		 WHERE source = 'cdp_recv'
		   AND method IN ('Network.requestWillBeSent','Network.responseReceived','Network.loadingFailed')
		   AND ts > ?
		 ORDER BY id`,
		[anchorTs - 60000],
	);
	const requestUrls = new Map<string, { url: string; method?: string }>();
	const failures: Array<{
		url: string;
		ts: number;
		method?: string;
		status?: number;
		error?: string;
	}> = [];
	for (const row of rows) {
		let data: {
			event?: {
				requestId?: string;
				request?: { url?: string; method?: string };
				response?: { url?: string; status?: number };
				errorText?: string;
			};
		};
		try {
			data = JSON.parse(String(row.data ?? "{}"));
		} catch {
			continue;
		}
		const event = data.event;
		if (!event) continue;
		const ts = Number(row.ts);
		if (row.method === "Network.requestWillBeSent") {
			if (event.requestId && event.request?.url) {
				requestUrls.set(event.requestId, {
					url: event.request.url,
					method: event.request.method,
				});
			}
		} else if (ts > anchorTs && row.method === "Network.loadingFailed") {
			const req = event.requestId ? requestUrls.get(event.requestId) : null;
			failures.push({
				url: req?.url ?? "(unknown)",
				ts,
				method: req?.method,
				error: event.errorText ?? "failed",
			});
		} else if (
			ts > anchorTs &&
			row.method === "Network.responseReceived" &&
			(event.response?.status ?? 0) >= 400
		) {
			const req = event.requestId ? requestUrls.get(event.requestId) : null;
			failures.push({
				url: event.response?.url ?? req?.url ?? "(unknown)",
				ts,
				method: req?.method,
				status: event.response?.status,
			});
		}
	}
	return failures;
}

/** Reconstruct full network requests (method, url, status, duration) from
 * recorded CDP events since `sinceTs`, keyed by requestId. Used by the
 * networkDiff in `dbg after`. `ts` is the requestWillBeSent epoch-ms; duration
 * is derived from the loadingFinished/loadingFailed event ts. */
function reconstructNetworkRequests(
	sinceTs: number,
): Array<NetRequest & { ts: number }> {
	const rows = store.query(
		`SELECT ts, method, data FROM events
		 WHERE source = 'cdp_recv'
		   AND method IN ('Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed')
		   AND ts > ?
		 ORDER BY id`,
		[sinceTs],
	);
	const byId = new Map<string, NetRequest & { ts: number }>();
	for (const row of rows) {
		let data: {
			event?: {
				requestId?: string;
				request?: { url?: string; method?: string };
				response?: { url?: string; status?: number };
			};
		};
		try {
			data = JSON.parse(String(row.data ?? "{}"));
		} catch {
			continue;
		}
		const event = data.event;
		const requestId = event?.requestId;
		if (!requestId) continue;
		const ts = Number(row.ts);
		if (row.method === "Network.requestWillBeSent") {
			if (event?.request?.url) {
				byId.set(requestId, {
					method: event.request.method ?? "GET",
					url: event.request.url,
					status: 0,
					duration: 0,
					ts,
				});
			}
		} else if (row.method === "Network.responseReceived") {
			const req = byId.get(requestId);
			if (req && event?.response?.status != null) {
				req.status = event.response.status;
			}
		} else if (
			row.method === "Network.loadingFinished" ||
			row.method === "Network.loadingFailed"
		) {
			const req = byId.get(requestId);
			if (req) req.duration = Math.max(0, ts - req.ts);
		}
	}
	return [...byId.values()];
}

/** Navigate/scroll the recorder page back to a capture's state. */
async function restoreRecorderState(
	cdp: CdpClientWrapper,
	target: { url: string; scrollY: number },
): Promise<void> {
	let currentUrl = "";
	try {
		const result = (await cdp.send("Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		currentUrl = String(result.result?.value ?? "");
	} catch {
		// treat as unknown; navigate below
	}
	if (target.url && currentUrl !== target.url) {
		await cdp.send("Page.navigate", { url: target.url });
		await waitForPageLoad(cdp, 10000);
		if (recorder) recorder.dpr = await evaluateRecorderDpr(cdp);
	}
	try {
		await cdp.send("Runtime.evaluate", {
			expression: `window.scrollTo(0, ${Number(target.scrollY) || 0})`,
			returnByValue: true,
		});
	} catch {
		// best-effort
	}
}

function recordingsRootDir(): string {
	return path.join(process.cwd(), ".dbg", "recordings");
}

function openInBrowser(filePath: string): void {
	try {
		spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// never fail the command because `open` is unavailable
	}
}

async function handleRecordAfter(
	at?: string,
	open?: boolean,
	sections?: {
		noNetwork?: boolean;
		noState?: boolean;
		noA11y?: boolean;
		noPerf?: boolean;
	},
): Promise<Response> {
	if (!recorder) {
		return {
			ok: false,
			error: "no recording in progress (dbg record <url> first)",
		};
	}
	const session = registry.sessions.get(recorder.sessionName);
	const cdp = session ? asCdpExecutor(session) : null;
	if (!session || !cdp) {
		return { ok: false, error: "recorder session unavailable" };
	}

	const spec = parseAnchorSpec(at);
	if ("error" in spec) return { ok: false, error: spec.error };

	const captures = recorderCaptureRows(recorder.sessionName);
	const epochs = recorderEpochRows(recorder.sessionName);
	const anchor = resolveAnchor(spec, captures, epochs);
	if (!anchor) {
		return {
			ok: false,
			error: `no anchor capture found for --at "${at ?? "(default)"}"`,
		};
	}

	// Decayed anchor: its full-resolution pixels were pruned by retention.
	// (Epoch anchors and diff baselines are protected, so this is the
	// fallback path, not the norm.) Point at the nearest still-full capture.
	if ((anchor.tier ?? "full") !== "full") {
		const nearestFull = captures
			.filter((c) => (c.tier ?? "full") === "full")
			.reduce<AnchorCaptureRow | null>(
				(best, c) =>
					!best || Math.abs(c.ts - anchor.ts) < Math.abs(best.ts - anchor.ts)
						? c
						: best,
				null,
			);
		return {
			ok: false,
			error: nearestFull
				? `anchor capture:${anchor.id} has decayed to '${anchor.tier}' (full pixels pruned by retention); nearest full capture is capture:${nearestFull.id} — try: dbg after --at capture:${nearestFull.id}`
				: `anchor capture:${anchor.id} has decayed to '${anchor.tier}' (full pixels pruned by retention) and no full captures remain`,
		};
	}

	let beforePng: Buffer;
	try {
		beforePng = fs.readFileSync(anchor.pngPath);
	} catch {
		return {
			ok: false,
			error: `anchor capture PNG missing: ${anchor.pngPath}`,
		};
	}

	try {
		await restoreRecorderState(cdp, anchor);
		const frame = await forceRecorderCapture(session);
		if (!frame) {
			return { ok: false, error: "fresh capture failed" };
		}
		const afterPng = fs.readFileSync(frame.pngPath);
		const diff = diffPngs(beforePng, afterPng);
		const afterTs = recorder.lastCaptureTs ?? Date.now();

		const consoleNew = consoleDeltaSince(session, anchor.ts).errors;
		const exceptionsNew = session.state.exceptions
			.filter((e) => e.ts > anchor.ts)
			.map((e) => ({ type: e.type, text: e.text, ts: e.ts }));
		const networkNew = networkDeltaSince(anchor.ts);

		// ── Plan V: network diff, state (storage) diff, new a11y issues ──
		// Each section is individually skippable (--no-network/--no-state/
		// --no-a11y) to keep `after` fast when a section isn't needed.
		let networkDiff: NetworkDiff | undefined;
		if (!sections?.noNetwork) {
			const netReqs = reconstructNetworkRequests(anchor.ts - 60000);
			networkDiff = diffNetwork(
				netReqs.filter((r) => r.ts <= anchor.ts),
				netReqs.filter((r) => r.ts > anchor.ts),
			);
		}
		const stateChanges: StateChange[] = sections?.noState
			? []
			: diffStorage(
					loadStorageSnapshot(anchor.id),
					loadStorageSnapshot(frame.id),
				);
		let a11yNew: Array<{ rule: string; selector: string; detail: string }> = [];
		if (!sections?.noA11y) {
			const a11yBefore = new Set(
				loadA11yIssues(anchor.id).map((i) => `${i.rule}|${i.selector}`),
			);
			a11yNew = loadA11yIssues(frame.id).filter(
				(i) => !a11yBefore.has(`${i.rule}|${i.selector}`),
			);
		}

		// ── Plan X: perf delta — pure store reads, no extra CDP round-trips. ──
		let perfDelta: PerfDelta | undefined;
		if (!sections?.noPerf) {
			const perfRows: PerfSampleRow[] = store
				.query(
					"SELECT ts, nav_id, capture_id, metric, value, detail FROM perf_samples",
				)
				.map((row) => ({
					ts: Number(row.ts),
					navId: Number(row.nav_id),
					captureId: row.capture_id == null ? null : Number(row.capture_id),
					metric: String(row.metric),
					value: Number(row.value),
					detail: row.detail == null ? null : String(row.detail),
				}));
			perfDelta = computePerfDelta(
				perfRows,
				anchor.id,
				frame.id,
				anchor.ts,
				afterTs,
			);
		}

		// ── Phase 4: component blame + structural style diff ──
		const baselineSnapshot = loadPageSnapshot(anchor.snapshotPath);
		const afterSnapshot = loadPageSnapshot(frame.snapshotPath);
		const changedSince = store
			.query(
				`SELECT changed_files, hmr_modules FROM captures
				 WHERE session_id = ? AND ts > ?`,
				[recorder.sessionName, anchor.ts],
			)
			.flatMap((row) => [
				...safeJsonArray(row.changed_files),
				...safeJsonArray(row.hmr_modules),
			]);
		const regions = afterSnapshot
			? buildRegions(
					diff.clusters,
					afterSnapshot.components,
					changedSince,
					recorder.dpr,
				)
			: [];
		const styleChanges =
			baselineSnapshot && afterSnapshot
				? diffSnapshots(baselineSnapshot.elements, afterSnapshot.elements)
				: [];

		const root = recordingsRootDir();
		fs.mkdirSync(root, { recursive: true });
		// PNG diff lives next to the captures it compares.
		const diffPngPath = path.join(
			recorder.recordingDir,
			`diff-${anchor.id}-${frame.id}.png`,
		);
		fs.writeFileSync(diffPngPath, diff.diffPng);

		const pairName = `capture ${anchor.id} → capture ${frame.id}`;
		const anchorLabel = `capture:${anchor.id} (${new Date(anchor.ts).toISOString()})`;
		const reportPath = path.join(root, "report.html");
		const html = renderReport({
			pairs: [
				{
					name: pairName,
					beforePng,
					afterPng,
					diffPng: diff.diffPng,
					stats: {
						diffPixels: diff.diffPixels,
						totalPixels: diff.totalPixels,
						diffPercent: diff.diffPercent,
						width: diff.width,
						height: diff.height,
						dimensionsChanged: diff.dimensionsChanged,
					},
					regions: regions.map((r) => ({
						box: r.box,
						label: r.causal ? `${r.label} (causal)` : r.label,
					})),
					styleChanges,
					newErrors: [...consoleNew, ...exceptionsNew],
					newNetworkFailures: networkNew.map((f) => ({
						url: f.url,
						ts: f.ts,
						method: f.method,
						status: f.status,
						text: f.error,
					})),
					networkDiff,
					stateChanges,
					a11yIssues: a11yNew,
					perfDelta,
				},
			],
			meta: {
				generatedAt: new Date().toISOString(),
				anchor: anchorLabel,
			},
		});
		fs.writeFileSync(reportPath, html);
		if (open) openInBrowser(reportPath);

		const diffId = store.insertDiff({
			name: pairName,
			baselineCaptureId: anchor.id,
			afterCaptureId: frame.id,
			diffPercent: diff.diffPercent,
			diffPixels: diff.diffPixels,
			reportPath,
		});
		store.insertRegions(
			regions.map((r) => ({
				diffId,
				x: r.box.x,
				y: r.box.y,
				w: r.box.w,
				h: r.box.h,
				component: r.component,
				file: r.file,
				causal: r.causal,
			})),
		);
		store.record(
			{
				source: "daemon",
				category: "recording",
				method: "record.after",
				data: { diffId, baseline: anchor.id, after: frame.id },
				sessionId: recorder.sessionName,
			},
			true,
		);

		return {
			ok: true,
			messages: [
				`${diff.diffPercent.toFixed(2)}% changed vs ${anchorLabel}`,
				`diff png: ${diffPngPath}`,
				`report: ${reportPath}`,
			],
			pair: {
				name: pairName,
				baseline: { captureId: anchor.id, ts: anchor.ts },
				after: { captureId: frame.id, ts: afterTs },
				diffPercent: diff.diffPercent,
				diffPixels: diff.diffPixels,
				dimensionsChanged: diff.dimensionsChanged,
				clusters: diff.clusters.length,
			},
			consoleDelta: { new: consoleNew },
			exceptionDelta: { new: exceptionsNew },
			networkDelta: { failed: networkNew },
			networkDiff,
			stateChanges,
			a11yNew,
			perfDelta,
			regions,
			styleChanges,
			reportPath,
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

// ── Plan V: dbg why — blame the most recent (or matched) error ──
function stackUrlsFromTrace(trace: unknown): string {
	const frames = (trace as { callFrames?: Array<{ url?: string }> })
		?.callFrames;
	if (!Array.isArray(frames)) return "";
	return frames
		.map((f) => (typeof f.url === "string" ? f.url : ""))
		.filter(Boolean)
		.join(" ");
}

function consoleArgsText(args: unknown): string {
	if (!Array.isArray(args)) return "";
	return args
		.map((a) => {
			if (typeof a !== "object" || a === null) return String(a);
			const rec = a as Record<string, unknown>;
			if (rec.value !== undefined) return String(rec.value);
			if (typeof rec.description === "string") return rec.description;
			return typeof rec.type === "string" ? `[${rec.type}]` : "";
		})
		.filter(Boolean)
		.join(" ");
}

/** Reconstruct persisted console errors/asserts + exceptions from the events
 * store (epoch-ms ts) so `dbg why` works after `record --stop`. Deduped by
 * text+second (Chrome double-reports console.error via Runtime + Log). Tap
 * sentinels (Plan W) are filtered here — the single console-dedupe choke. */
function persistedErrors(): Array<{ ts: number; text: string; stack: string }> {
	const rows = store.query(
		`SELECT ts, method, data FROM events
		 WHERE source = 'cdp_recv'
		   AND method IN ('Runtime.consoleAPICalled','Log.entryAdded','Runtime.exceptionThrown')
		 ORDER BY id`,
	);
	const out: Array<{ ts: number; text: string; stack: string }> = [];
	const seen = new Set<string>();
	const add = (ts: number, text: string, stack: string): void => {
		if (text === "" || text.startsWith("__dbg_tap:")) return; // Plan W sentinel
		const key = `${text}|${Math.floor(ts / 1000)}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ ts, text, stack });
	};
	for (const row of rows) {
		let data: { event?: Record<string, unknown> };
		try {
			data = JSON.parse(String(row.data ?? "{}"));
		} catch {
			continue;
		}
		const event = data.event;
		if (!event) continue;
		const ts = Number(row.ts);
		if (row.method === "Runtime.consoleAPICalled") {
			const type = String(event.type ?? "");
			if (type !== "error" && type !== "assert") continue;
			add(
				ts,
				consoleArgsText(event.args),
				stackUrlsFromTrace(event.stackTrace),
			);
		} else if (row.method === "Log.entryAdded") {
			const entry = event.entry as Record<string, unknown> | undefined;
			if (entry?.level !== "error") continue;
			add(ts, String(entry.text ?? ""), String(entry.url ?? ""));
		} else if (row.method === "Runtime.exceptionThrown") {
			const ed = event.exceptionDetails as Record<string, unknown> | undefined;
			if (!ed) continue;
			const exception = ed.exception as Record<string, unknown> | undefined;
			const text = String(exception?.description ?? ed.text ?? "exception");
			const stack = `${String(exception?.description ?? "")} ${String(ed.url ?? "")} ${stackUrlsFromTrace(ed.stackTrace)}`;
			add(ts, text, stack);
		}
	}
	return out;
}

async function handleWhy(substring?: string, cwd?: string): Promise<Response> {
	// Errors are read from the PERSISTED events store, so `dbg why` works after
	// `record --stop` (subject to the events TTL).
	const errs = persistedErrors();
	if (errs.length === 0) {
		return { ok: false, error: "no errors or exceptions recorded" };
	}
	errs.sort((a, b) => a.ts - b.ts);

	const matched = substring
		? errs.filter((e) => e.text.toLowerCase().includes(substring.toLowerCase()))
		: errs;
	if (matched.length === 0) {
		return { ok: false, error: `no error matching "${substring}"` };
	}
	const target = matched[matched.length - 1];
	// first-seen ts for this exact text (the error may repeat).
	const targetTs = (errs.find((e) => e.text === target.text) ?? target).ts;

	const windowMs = 5 * 60 * 1000;
	const edits = store
		.query(
			"SELECT ts, path, epoch_id FROM edits WHERE session_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
			[RECORDER_SESSION, targetTs - windowMs, targetTs],
		)
		.map((r) => ({
			ts: Number(r.ts),
			path: String(r.path),
			epochId: r.epoch_id == null ? null : Number(r.epoch_id),
		}));
	const epochs = store
		.query(
			"SELECT id, ts, name FROM epochs WHERE session_id = ? AND ts <= ? ORDER BY ts",
			[RECORDER_SESSION, targetTs],
		)
		.map((r) => ({
			id: Number(r.id),
			ts: Number(r.ts),
			name: r.name == null ? null : String(r.name),
		}));

	// Commits + prompts via the dev tables, scoped to the client's cwd. Works
	// with no live session (a throwaway store-backed executor suffices).
	const session = registry.sessions.get(RECORDER_SESSION) ?? null;
	const executor =
		session?.executor ?? new CdpClientWrapper(createState(), store);
	setScopeCwd(cwd ?? null);
	let commits: WhyCandidates["commits"] = [];
	let prompts: WhyCandidates["prompts"] = [];
	try {
		const cRes = await commitsTable.fetch(null, executor);
		commits = cRes.rows.map((row) => ({
			ts: Number(row[2]),
			shortHash: String(row[1] ?? ""),
			summary: String(row[4] ?? ""),
		}));
		const pRes = await agentPromptsTable.fetch(null, executor);
		prompts = pRes.rows.map((row) => ({
			ts: Number(row[0]),
			display: String(row[1] ?? ""),
		}));
	} catch {
		// dev tables are optional context
	} finally {
		setScopeCwd(null);
	}

	const verdict: WhyVerdict = rankCauses(
		{ ts: targetTs, text: target.text, stack: target.stack },
		{ edits, epochs, commits, prompts },
		windowMs,
	);
	return { ok: true, why: verdict, messages: [verdict.answer] };
}

// ── Plan W: taps (logpoints) ──
async function handleTapAdd(
	session: Session,
	file: string,
	line: number,
	expr: string,
	url?: string,
): Promise<Response> {
	if (session.executor.protocol !== "cdp") {
		return { ok: false, error: "taps require a browser or node (CDP) session" };
	}
	const urlRegex = url ?? suffixUrlRegex(file);
	const cdpLine = Math.max(0, line - 1); // users give 1-based; CDP wants 0-based
	// Insert first so the sentinel can carry the tap id; roll back on failure.
	const tapId = store.insertTap({
		sessionId: session.name,
		breakpointId: "",
		file,
		line,
		expr,
		urlRegex,
	});
	const condition = buildTapCondition(tapId, expr);
	try {
		const result = (await session.executor.send("Debugger.setBreakpointByUrl", {
			lineNumber: cdpLine,
			urlRegex,
			columnNumber: 0,
			condition,
		})) as {
			breakpointId: string;
			locations: Array<{ scriptId: string; lineNumber: number }>;
		};
		store.run("UPDATE taps SET breakpoint_id = ? WHERE id = ?", [
			result.breakpointId,
			tapId,
		]);
		const loc = result.locations?.[0];
		const armed = loc
			? `armed on ${
					session.state.scripts.get(loc.scriptId)?.url ?? "(loaded script)"
				}:${loc.lineNumber + 1}`
			: "arms on script load (no matching script yet)";
		return {
			ok: true,
			id: String(tapId),
			messages: [`tap ${tapId} ${armed}`, `expr: ${expr}`],
		};
	} catch (e) {
		store.run("DELETE FROM taps WHERE id = ?", [tapId]);
		return { ok: false, error: `tap add failed: ${(e as Error).message}` };
	}
}

function handleTapList(): Response {
	const rows = store.query(
		`SELECT id, session_id, file, line, expr, url_regex, enabled, created_ts
		 FROM taps ORDER BY id`,
	);
	return {
		ok: true,
		columns: [
			"id",
			"session_id",
			"file",
			"line",
			"expr",
			"url_regex",
			"enabled",
			"created_ts",
		],
		rows: rows.map((r) => [
			r.id,
			r.session_id,
			r.file,
			r.line,
			r.expr,
			r.url_regex,
			r.enabled,
			r.created_ts,
		]),
	};
}

async function handleTapRm(id: number): Promise<Response> {
	const rows = store.query(
		"SELECT breakpoint_id, session_id FROM taps WHERE id = ?",
		[id],
	);
	if (rows.length === 0) return { ok: false, error: `tap not found: ${id}` };
	const breakpointId = String(rows[0].breakpoint_id ?? "");
	const sessionName = String(rows[0].session_id ?? "");
	const session = registry.sessions.get(sessionName);
	if (session && breakpointId) {
		try {
			await session.executor.send("Debugger.removeBreakpoint", {
				breakpointId,
			});
		} catch {
			// breakpoint already gone (session reloaded/closed) — just drop the row
		}
	}
	store.run("DELETE FROM tap_hits WHERE tap_id = ?", [id]);
	store.run("DELETE FROM taps WHERE id = ?", [id]);
	return { ok: true, id: String(id), messages: [`tap ${id} removed`] };
}

function handleTapHits(id: number, tail?: number): Response {
	const limit = tail && tail > 0 ? tail : 100;
	const rows = store
		.query(
			"SELECT ts, value FROM tap_hits WHERE tap_id = ? ORDER BY id DESC LIMIT ?",
			[id, limit],
		)
		.reverse();
	return {
		ok: true,
		columns: ["ts", "value"],
		rows: rows.map((r) => [r.ts, r.value]),
	};
}

function latestFlowByName(name: string): Record<string, unknown> | null {
	const rows = store.query(
		"SELECT id, ts, name, url, session_id FROM flows WHERE name = ? ORDER BY id DESC LIMIT 1",
		[name],
	);
	return rows[0] ?? null;
}

async function handleFlowRecord(name: string, url?: string): Promise<Response> {
	const r = recorder;
	if (!r) {
		return {
			ok: false,
			error: "recording is not running; start dbg record first",
		};
	}
	if (r.flowRecording) {
		return { ok: false, error: "flow recording already active; stop it first" };
	}
	const session = registry.sessions.get(r.sessionName);
	const cdp = session ? asCdpExecutor(session) : null;
	if (!session || !cdp) {
		return { ok: false, error: "recorder session is not connected" };
	}
	if (!name.trim()) return { ok: false, error: "flow name required" };
	if (url) {
		const nav = (await cdp.send("Page.navigate", { url })) as {
			errorText?: string;
		};
		if (nav.errorText)
			return { ok: false, error: `navigation failed: ${nav.errorText}` };
		await waitForPageLoad(cdp, 10000);
	}
	const flowUrl = await currentRecorderUrl(cdp, url ?? r.urls[0]);
	const flowId = store.insertFlow({
		name,
		url: flowUrl,
		sessionId: r.sessionName,
	});
	r.flowRecording = { flowId, order: 0 };
	return {
		ok: true,
		columns: ["id", "name", "url"],
		rows: [[flowId, name, flowUrl]],
		messages: [`recording flow ${name}`],
	};
}

async function currentRecorderUrl(
	cdp: CdpClientWrapper,
	fallback: string,
): Promise<string> {
	try {
		const result = (await cdp.send("Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		if (typeof result.result?.value === "string") return result.result.value;
	} catch {
		// fallback below
	}
	return fallback;
}

function handleFlowStop(): Response {
	const r = recorder;
	if (!r?.flowRecording) {
		return { ok: false, error: "no flow recording is active" };
	}
	const flowId = r.flowRecording.flowId;
	r.flowRecording = null;
	const rows = store.query(
		"SELECT COUNT(*) AS c FROM flow_steps WHERE flow_id = ?",
		[flowId],
	);
	return {
		ok: true,
		messages: [`flow recording stopped (${Number(rows[0]?.c ?? 0)} steps)`],
	};
}

function handleFlowList(): Response {
	const rows = store
		.query(
			`SELECT f.id, f.name, f.url, f.ts, COUNT(s.id) AS steps
			 FROM flows f
			 LEFT JOIN flow_steps s ON s.flow_id = f.id
			 GROUP BY f.id
			 ORDER BY f.id DESC`,
		)
		.map((r) => [r.id, r.name, r.url, r.steps, r.ts]);
	return {
		ok: true,
		columns: ["id", "name", "url", "steps", "ts"],
		rows,
		messages: [`${rows.length} flows`],
	};
}

function handleFlowShow(name: string): Response {
	const flow = latestFlowByName(name);
	if (!flow) return { ok: false, error: `flow not found: ${name}` };
	const rows = store
		.query(
			`SELECT id, idx, kind, selector, fallback_path, value
			 FROM flow_steps WHERE flow_id = ? ORDER BY idx`,
			[flow.id],
		)
		.map((r) => [r.id, r.idx, r.kind, r.selector, r.fallback_path, r.value]);
	return {
		ok: true,
		columns: ["id", "idx", "kind", "selector", "fallback_path", "value"],
		rows,
		messages: [`flow ${name}: ${rows.length} steps`],
	};
}

interface FlowStepRow {
	id: number;
	idx: number;
	kind: string;
	selector: string | null;
	fallbackPath: string | null;
	value: string | null;
}

async function handleFlowRun(
	name: string,
	stepTimeoutMs = 5000,
): Promise<Response> {
	const r = recorder;
	if (!r) {
		return {
			ok: false,
			error: "recording is not running; start dbg record first",
		};
	}
	const session = registry.sessions.get(r.sessionName);
	const cdp = session ? asCdpExecutor(session) : null;
	if (!session || !cdp) {
		return { ok: false, error: "recorder session is not connected" };
	}
	const flow = latestFlowByName(name);
	if (!flow) return { ok: false, error: `flow not found: ${name}` };
	const flowId = Number(flow.id);
	const flowUrl = String(flow.url ?? "");
	const steps: FlowStepRow[] = store
		.query(
			`SELECT id, idx, kind, selector, fallback_path, value
			 FROM flow_steps WHERE flow_id = ? ORDER BY idx`,
			[flowId],
		)
		.map((row) => ({
			id: Number(row.id),
			idx: Number(row.idx),
			kind: String(row.kind),
			selector: row.selector == null ? null : String(row.selector),
			fallbackPath:
				row.fallback_path == null ? null : String(row.fallback_path),
			value: row.value == null ? null : String(row.value),
		}));
	if (steps.length === 0)
		return { ok: false, error: `flow has no steps: ${name}` };

	r.flowRecording = null;
	const nav = (await cdp.send("Page.navigate", { url: flowUrl })) as {
		errorText?: string;
	};
	if (nav.errorText)
		return { ok: false, error: `navigation failed: ${nav.errorText}` };
	await waitForPageLoad(cdp, 10000);

	const runId = store.insertFlowRun({
		flowId,
		status: "running",
		stepsTotal: steps.length,
		stepsPassed: 0,
	});
	const resultSteps: FlowRunResult["steps"] = [];
	const newErrors: FlowRunResult["newErrors"] = [];
	let stepsPassed = 0;
	let failed = false;

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (failed) {
			store.insertFlowRunStep({
				runId,
				stepId: step.id,
				idx: step.idx,
				kind: step.kind,
				status: "skipped",
			});
			resultSteps.push({
				idx: step.idx,
				kind: step.kind,
				selector: step.selector,
				status: "skipped",
				captureId: null,
				error: null,
				diffPercent: null,
			});
			continue;
		}

		const stepStartTs = Date.now();
		let status = "passed";
		let error: string | null = null;
		let captureId: number | null = null;
		let diffPercent: number | null = null;
		try {
			if (requiresActionableElement(step.kind)) {
				const ready = await waitForActionable(
					cdp,
					step.selector,
					step.fallbackPath,
					stepTimeoutMs,
				);
				if (!ready.ready) {
					throw new Error(
						`readiness timeout: ${ready.selector ?? step.selector ?? step.fallbackPath ?? "(no selector)"} not actionable (${ready.reason})`,
					);
				}
			}
			await executeFlowStep(cdp, step);
			await new Promise((resolve) => setTimeout(resolve, 500));
		} catch (e) {
			status = "failed";
			error = (e as Error).message;
			failed = true;
		}

		const frame = await forceRecorderCapture(session);
		captureId = frame?.id ?? null;
		for (const entry of consoleDeltaSince(session, stepStartTs).errors) {
			newErrors.push(entry);
		}
		if (captureId != null) {
			diffPercent = diffPercentAgainstPreviousRun(step.id, runId, captureId);
		}
		store.insertFlowRunStep({
			runId,
			stepId: step.id,
			idx: step.idx,
			kind: step.kind,
			status,
			captureId,
			error,
			diffPercent,
		});
		if (status === "passed") stepsPassed++;
		resultSteps.push({
			idx: step.idx,
			kind: step.kind,
			selector: step.selector,
			status,
			captureId,
			error,
			diffPercent,
		});
	}

	const status = failed ? "failed" : "passed";
	store.run("UPDATE flow_runs SET status = ?, steps_passed = ? WHERE id = ?", [
		status,
		stepsPassed,
		runId,
	]);
	const flowRun: FlowRunResult = {
		runId,
		flowName: name,
		status,
		stepsTotal: steps.length,
		stepsPassed,
		stepsFailed: resultSteps.filter((s) => s.status === "failed").length,
		newErrors,
		steps: resultSteps,
	};
	return {
		ok: true,
		flowRun,
		messages: [
			`flow ${name}: ${stepsPassed}/${steps.length} steps passed`,
			...resultSteps
				.filter((s) => s.status === "failed")
				.map((s) => `step ${s.idx} ${s.kind} failed: ${s.error}`),
		],
	};
}

function requiresActionableElement(kind: string): boolean {
	return kind === "click" || kind === "input" || kind === "keypress";
}

async function executeFlowStep(
	cdp: DebugExecutor,
	step: FlowStepRow,
): Promise<void> {
	switch (step.kind) {
		case "click":
			await replayClick(cdp, step.selector, step.fallbackPath);
			return;
		case "input":
			await replayInput(
				cdp,
				step.selector,
				step.fallbackPath,
				step.value ?? "",
			);
			return;
		case "keypress":
			await replayKeypress(
				cdp,
				step.selector,
				step.fallbackPath,
				step.value ?? "",
			);
			return;
		case "scroll":
			await replayScroll(cdp, step.value ?? "0");
			return;
		case "nav": {
			const nav = (await cdp.send("Page.navigate", {
				url: step.value ?? "",
			})) as { errorText?: string };
			if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
			await waitForPageLoad(cdp as CdpClientWrapper, 10000);
			return;
		}
		default:
			throw new Error(`unsupported flow step kind: ${step.kind}`);
	}
}

function diffPercentAgainstPreviousRun(
	stepId: number,
	currentRunId: number,
	captureId: number,
): number | null {
	const prev = store.query(
		`SELECT capture_id FROM flow_run_steps
		 WHERE step_id = ? AND run_id != ? AND capture_id IS NOT NULL
		 ORDER BY id DESC LIMIT 1`,
		[stepId, currentRunId],
	)[0];
	if (!prev?.capture_id) return null;
	const prevPath = capturePngPath(Number(prev.capture_id));
	const currentPath = capturePngPath(captureId);
	if (!prevPath || !currentPath) return null;
	try {
		return diffPngs(fs.readFileSync(prevPath), fs.readFileSync(currentPath))
			.diffPercent;
	} catch {
		return null;
	}
}

function capturePngPath(captureId: number): string | null {
	const row = store.query("SELECT png_path FROM captures WHERE id = ?", [
		captureId,
	])[0];
	return row?.png_path == null ? null : String(row.png_path);
}

const TIMELINE_DEFAULT_LIMIT = 100;
// Commit/prompt chips are interleaved into the timeline strip when their ts
// falls within the frame window, widened by this margin on each side so a
// commit or prompt just before/after the recording still shows.
const TIMELINE_CHIP_MARGIN_MS = 5 * 60 * 1000;

async function handleRecordTimeline(
	open?: boolean,
	limit?: number,
): Promise<Response> {
	const captures = recorderCaptureRows(RECORDER_SESSION);
	if (captures.length === 0) {
		return { ok: false, error: "no captures recorded yet" };
	}
	const epochNames = new Map<number, string>();
	for (const epoch of recorderEpochRows(RECORDER_SESSION)) {
		epochNames.set(epoch.id, epoch.name ?? `auto ${epoch.id}`);
	}
	// Embed at most the most recent `limit` frames (PNGs are inlined as data
	// URIs — an unbounded strip would grow without bound with the recording).
	const frameLimit = limit && limit > 0 ? limit : TIMELINE_DEFAULT_LIMIT;
	const totalFrames = Number(
		store.query("SELECT COUNT(*) AS c FROM captures WHERE session_id = ?", [
			RECORDER_SESSION,
		])[0]?.c ?? 0,
	);
	const rows = store
		.query(
			`SELECT id, ts, url, hmr_modules, epoch_id, png_path, changed_files, tier
			 FROM captures WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
			[RECORDER_SESSION, frameLimit],
		)
		.reverse();
	const frames: TimelineFrame[] = [];
	for (const row of rows) {
		const tier = String(row.tier ?? "full") as "full" | "thumb" | "meta";
		// Meta-tier frames keep their annotations (that's the point) and render
		// as a placeholder card; full/thumb frames embed their blob.
		let thumbPng: Buffer | undefined;
		if (tier !== "meta") {
			try {
				thumbPng = fs.readFileSync(String(row.png_path));
			} catch {
				continue; // externally-pruned/missing PNGs drop out of the strip
			}
		}
		const epochId = row.epoch_id == null ? null : Number(row.epoch_id);
		frames.push({
			id: Number(row.id),
			ts: Number(row.ts),
			thumbPng,
			tier,
			url: String(row.url ?? ""),
			changedFiles: safeJsonArray(row.changed_files),
			hmrModules: safeJsonArray(row.hmr_modules),
			epochName: epochId == null ? undefined : epochNames.get(epochId),
		});
	}
	// Per-capture console error counts: bucket each error into the last frame
	// at/before its timestamp (live session state; empty once recording stops).
	const session = registry.sessions.get(RECORDER_SESSION);
	if (session && frames.length > 0) {
		const counts = new Map<number, number>();
		const seen = new Set<string>();
		for (const entry of session.state.console) {
			if (entry.type !== "error" && entry.type !== "assert") continue;
			// Chrome reports console.error via both Runtime and Log domains;
			// collapse duplicates within a 1s window.
			const key = `${entry.type}|${entry.text}|${Math.floor(entry.ts / 1000)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			let bucket = -1;
			for (let i = 0; i < frames.length; i++) {
				if (frames[i].ts <= entry.ts) bucket = i;
				else break;
			}
			if (bucket >= 0) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
		}
		for (const [index, count] of counts) {
			frames[index].logCounts = { error: count };
		}
	}
	// Commit + prompt chips: gather git commits and agent prompts whose ts
	// falls within the frame window (+/- a small margin) and interleave them
	// into the strip. Commits/prompts read git + ~/.claude via the dev tables,
	// scoped to the daemon's cwd (the recorded project).
	const commits: Array<{ ts: number; shortHash: string; summary: string }> = [];
	const prompts: Array<{ ts: number; text: string }> = [];
	if (frames.length > 0) {
		const winMin = frames[0].ts - TIMELINE_CHIP_MARGIN_MS;
		const winMax = frames[frames.length - 1].ts + TIMELINE_CHIP_MARGIN_MS;
		const qExec =
			session?.executor ?? new CdpClientWrapper(createState(), store);
		try {
			const c = await commitsTable.fetch(null, qExec);
			for (const row of c.rows) {
				const ts = Number(row[2]);
				if (ts >= winMin && ts <= winMax) {
					commits.push({
						ts,
						shortHash: String(row[1] ?? ""),
						summary: String(row[4] ?? ""),
					});
				}
			}
		} catch {
			// git unavailable — render without commit chips
		}
		try {
			const p = await agentPromptsTable.fetch(null, qExec);
			for (const row of p.rows) {
				const ts = Number(row[0]);
				if (ts >= winMin && ts <= winMax) {
					prompts.push({ ts, text: String(row[1] ?? "").slice(0, 60) });
				}
			}
		} catch {
			// no agent history — render without prompt chips
		}
	}

	const root = recordingsRootDir();
	fs.mkdirSync(root, { recursive: true });
	const timelinePath = path.join(root, "timeline.html");
	fs.writeFileSync(
		timelinePath,
		renderTimeline({
			frames,
			commits,
			prompts,
			meta: { generatedAt: new Date().toISOString(), totalFrames },
		}),
	);
	if (open) openInBrowser(timelinePath);
	const shownNote =
		totalFrames > frames.length
			? ` (showing last ${frames.length} of ${totalFrames})`
			: "";
	return {
		ok: true,
		messages: [
			`timeline (${frames.length} frames${shownNote}): ${timelinePath}`,
		],
	};
}

async function handleRecordReplay(captureId: number): Promise<Response> {
	if (!recorder) {
		return {
			ok: false,
			error: "no recording in progress (dbg record <url> first)",
		};
	}
	const session = registry.sessions.get(recorder.sessionName);
	const cdp = session ? asCdpExecutor(session) : null;
	if (!session || !cdp) {
		return { ok: false, error: "recorder session unavailable" };
	}
	const capture = recorderCaptureRows(recorder.sessionName).find(
		(c) => c.id === captureId,
	);
	if (!capture) {
		return { ok: false, error: `unknown capture: ${captureId}` };
	}
	try {
		await restoreRecorderState(cdp, capture);
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	return {
		ok: true,
		messages: [
			`restored capture ${capture.id}: ${capture.url} @ scrollY ${capture.scrollY}`,
		],
	};
}

// ─── record.shoot (Phase 5): one-off deliberate captures ───

const SHOOT_PSEUDO_STATES = new Set([
	"hover",
	"focus",
	"active",
	"visited",
	"focus-within",
	"focus-visible",
]);

interface ComponentHarness {
	url: string;
	close(): void;
}

/** Bundle a component file with the user's own react/react-dom (resolved
 * from the component's directory) and serve it on an ephemeral port. */
async function buildComponentHarness(
	componentPath: string,
	propsJson?: string,
): Promise<ComponentHarness> {
	let props: unknown = {};
	if (propsJson) {
		props = JSON.parse(propsJson); // caller surfaces parse errors
	}
	const entry = `
		import * as React from "react";
		import { createRoot } from "react-dom/client";
		import * as Mod from ${JSON.stringify(componentPath)};
		const Component = Mod.default ?? Object.values(Mod)[0];
		createRoot(document.getElementById("dbg-root")).render(
			React.createElement(Component, ${JSON.stringify(props)}),
		);
	`;
	const esbuild = await import("esbuild");
	const result = await esbuild.build({
		stdin: {
			contents: entry,
			resolveDir: path.dirname(componentPath),
			loader: "tsx",
		},
		bundle: true,
		write: false,
		platform: "browser",
		define: { "process.env.NODE_ENV": '"development"' },
		jsx: "automatic",
	});
	const bundle = result.outputFiles?.[0]?.text ?? "";
	const html =
		'<!doctype html><html><head><meta charset="utf-8"><title>dbg shoot harness</title></head><body style="margin:0;padding:16px;background:#fff"><div id="dbg-root"></div><script src="/bundle.js"></script></body></html>';

	const server = http.createServer((req, res) => {
		if (req.url?.startsWith("/bundle.js")) {
			res.writeHead(200, { "content-type": "text/javascript" });
			res.end(bundle);
		} else {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(html);
		}
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("harness server has no port"));
		});
	});
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => server.close(),
	};
}

async function forceShootPseudoState(
	cdp: CdpClientWrapper,
	selector: string,
	classes: string[],
): Promise<void> {
	const doc = (await cdp.send("DOM.getDocument", { depth: 1 })) as {
		root: { nodeId: number };
	};
	const found = (await cdp.send("DOM.querySelector", {
		nodeId: doc.root.nodeId,
		selector,
	})) as { nodeId: number };
	if (!found.nodeId) throw new Error(`selector not found: ${selector}`);
	await cdp.send("CSS.forcePseudoState", {
		nodeId: found.nodeId,
		forcedPseudoClasses: classes,
	});
}

async function shootCapture(
	cdp: CdpClientWrapper,
	outDir: string,
	baseName: string,
	stateName: string,
	selector: string | null,
	fullPage: boolean,
	url: string,
): Promise<{ state: string; path: string }> {
	let clip: Record<string, number> | null = null;
	if (selector && !fullPage) {
		const result = (await cdp.send("Runtime.evaluate", {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return "";
				const r = el.getBoundingClientRect();
				return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
			})()`,
			returnByValue: true,
		})) as { result?: { value?: string } };
		if (!result.result?.value) {
			throw new Error(`selector not found: ${selector}`);
		}
		const rect = JSON.parse(result.result.value) as {
			x: number;
			y: number;
			width: number;
			height: number;
		};
		if (rect.width > 0 && rect.height > 0) {
			clip = { ...rect, scale: 1 };
		}
	}
	const shot = (await cdp.send("Page.captureScreenshot", {
		format: "png",
		...(fullPage ? { captureBeyondViewport: true } : {}),
		...(clip ? { clip } : {}),
	})) as { data: string };
	const buffer = Buffer.from(shot.data, "base64");
	fs.mkdirSync(outDir, { recursive: true });
	// Default state is the bare name; pseudo states are @-suffixed.
	const fileName =
		stateName === "default"
			? `${baseName}.png`
			: `${baseName}@${stateName}.png`;
	const pngPath = path.join(outDir, fileName);
	fs.writeFileSync(pngPath, buffer);
	// Shots are standalone PNGs, but also land as captures rows (session
	// "shoot") so they stay queryable next to recorder captures.
	store.insertCapture({
		sessionId: "shoot",
		url,
		hash: createHash("sha256").update(buffer).digest("hex").slice(0, 16),
		pngPath,
	});
	return { state: stateName, path: pngPath };
}

async function handleRecordShoot(cmd: {
	target: string;
	selector?: string;
	viewport?: { width: number; height: number };
	fullPage?: boolean;
	states?: string[];
	props?: string;
	name?: string;
	out?: string;
}): Promise<Response> {
	const states = cmd.states ?? [];
	for (const state of states) {
		if (!SHOOT_PSEUDO_STATES.has(state)) {
			return {
				ok: false,
				error: `unknown state "${state}" (expected: ${[...SHOOT_PSEUDO_STATES].join(", ")})`,
			};
		}
	}
	if (shootChrome) {
		return { ok: false, error: "another shoot is in progress; retry shortly" };
	}

	// http(s) and file:// targets are URL shoots; only non-URL filesystem
	// paths go through the component harness.
	const isUrl = /^(https?|file):\/\//i.test(cmd.target);
	let harness: ComponentHarness | null = null;
	let url = cmd.target;
	let selector = cmd.selector ?? null;
	let baseName = cmd.name ?? "shot";
	if (!isUrl) {
		const componentPath = path.resolve(process.cwd(), cmd.target);
		if (!fs.existsSync(componentPath)) {
			return { ok: false, error: `component file not found: ${componentPath}` };
		}
		if (!cmd.name) {
			baseName = path.basename(componentPath).replace(/\.[^.]+$/, "");
		}
		try {
			harness = await buildComponentHarness(componentPath, cmd.props);
		} catch (e) {
			return {
				ok: false,
				error: `harness build failed: ${(e as Error).message}`,
			};
		}
		url = harness.url;
		selector = selector ?? "#dbg-root";
	}

	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-shoot-"));
	let chrome: LaunchedChrome;
	try {
		chrome = await launchChrome({ profileDir });
	} catch (e) {
		harness?.close();
		fs.rmSync(profileDir, { recursive: true, force: true });
		return { ok: false, error: (e as Error).message };
	}
	shootChrome = chrome;

	const state = createState();
	const cdp = new CdpClientWrapper(state, store);
	try {
		const discoveryDeadline = Date.now() + 5000;
		let discovered: Awaited<ReturnType<typeof discoverTarget>>;
		for (;;) {
			try {
				discovered = await discoverTarget(chrome.port, "127.0.0.1", "page");
				break;
			} catch (e) {
				if (Date.now() >= discoveryDeadline) throw e;
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		await cdp.connect(discovered.wsUrl, "page");

		const viewport = cmd.viewport ?? { width: 1280, height: 800 };
		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: 1,
			mobile: false,
		});
		// Deterministic pixels: disable animations for the deliberate capture.
		await cdp.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});

		const nav = (await cdp.send("Page.navigate", { url })) as {
			errorText?: string;
		};
		if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
		await waitForPageLoad(cdp, 10000);
		// Let a harness (or late JS) paint before the deliberate capture.
		await new Promise((r) => setTimeout(r, 400));

		const outDir = cmd.out
			? path.resolve(process.cwd(), cmd.out)
			: path.join(process.cwd(), ".dbg", "shots");
		const shots: Array<{ state: string; path: string }> = [];
		shots.push(
			await shootCapture(
				cdp,
				outDir,
				baseName,
				"default",
				selector,
				cmd.fullPage ?? false,
				cmd.target,
			),
		);
		for (const pseudo of states) {
			await forceShootPseudoState(cdp, selector ?? "body", [pseudo]);
			await new Promise((r) => setTimeout(r, 150));
			shots.push(
				await shootCapture(
					cdp,
					outDir,
					baseName,
					pseudo,
					selector,
					cmd.fullPage ?? false,
					cmd.target,
				),
			);
			await forceShootPseudoState(cdp, selector ?? "body", []);
		}

		store.record(
			{
				source: "daemon",
				category: "recording",
				method: "record.shoot",
				data: { target: cmd.target, states, shots: shots.map((s) => s.path) },
			},
			true,
		);

		return {
			ok: true,
			shots,
			messages: shots.map((s) => `${s.state}: ${s.path}`),
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	} finally {
		try {
			await cdp.disconnect();
		} catch {
			// already gone
		}
		await chrome.kill();
		shootChrome = null;
		harness?.close();
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

// ─── Target listing ───

async function handleTargets(port: number, host?: string): Promise<Response> {
	const effectiveHost = host ?? "127.0.0.1";

	if (!Number.isFinite(port) || Number.isNaN(port)) {
		return { ok: false, error: "invalid port" };
	}

	try {
		const targets = await listTargets(port, effectiveHost);
		return {
			ok: true,
			columns: ["id", "type", "title", "url"],
			rows: targets.map((t) => [t.id, t.type, t.title, t.url]),
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

// ─── Apple device/simulator listing ───

async function handleDevices(platform?: AttachPlatform): Promise<Response> {
	const effectivePlatform: AttachPlatform = platform ?? "auto";
	if (platform && !ATTACH_PLATFORMS.includes(platform)) {
		return {
			ok: false,
			error: `unsupported platform '${platform}'. Supported: ${ATTACH_PLATFORMS.join(", ")}`,
		};
	}

	try {
		const targets = listAppleAttachTargets(effectivePlatform);
		return {
			ok: true,
			columns: [
				"kind",
				"platform",
				"booted",
				"identifier",
				"udid",
				"name",
				"runtime",
			],
			rows: targets.map((t) => [
				t.kind,
				t.platform,
				t.booted,
				t.identifier,
				t.udid ?? "",
				t.name,
				t.runtime ?? "",
			]),
		};
	} catch (error) {
		if (error instanceof AppleDeviceProviderError) {
			return {
				ok: false,
				error: error.message,
				errorCode: error.code,
			};
		}
		return { ok: false, error: (error as Error).message };
	}
}

// ─── App listing ───

async function handleApps(deviceId: string): Promise<Response> {
	if (!deviceId) {
		return { ok: false, error: "usage: apps <device-id>" };
	}
	try {
		const apps = listApps(deviceId);
		return {
			ok: true,
			columns: ["bundleId", "name", "url"],
			rows: apps.map((a) => [a.bundleIdentifier, a.name, a.url]),
		};
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

// ─── Session management commands ───

async function handleSessions(): Promise<Response> {
	const infos: SessionInfo[] = [];
	for (const [name, session] of registry.sessions) {
		infos.push({
			name,
			connected: session.state.connected,
			paused: session.state.paused,
			protocol: session.executor.protocol,
			targetType: session.targetType,
			port: session.port,
			host: session.host,
			pid: session.state.pid,
			current: name === registry.current,
			targetUrl: session.targetUrl,
			targetTitle: session.targetTitle,
		});
	}
	return {
		ok: true,
		columns: [
			"name",
			"protocol",
			"connected",
			"paused",
			"type",
			"port",
			"host",
			"pid",
			"current",
			"url",
			"title",
		],
		rows: infos.map((i) => [
			i.name,
			i.protocol,
			i.connected,
			i.paused,
			i.targetType,
			i.port,
			i.host,
			i.pid,
			i.current,
			i.targetUrl ?? "",
			i.targetTitle ?? "",
		]),
		sessions: infos,
	};
}

async function handleUse(name: string): Promise<Response> {
	if (!registry.sessions.has(name)) {
		return { ok: false, error: `no session named "${name}"` };
	}
	registry.current = name;
	return { ok: true, messages: [`current session: ${name}`] };
}

// ─── Browser commands ───

async function handleNavigate(
	session: Session,
	action: import("@dbg/types").NavigateAction,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (action.action === "reload") {
		await cdp.send("Page.reload", {});
		return { ok: true, messages: ["reloading"] };
	}

	if (action.action === "back") {
		const history = (await cdp.send("Page.getNavigationHistory", {})) as {
			currentIndex: number;
			entries: Array<{ id: number; url: string }>;
		};
		if (history.currentIndex > 0) {
			const entry = history.entries[history.currentIndex - 1];
			await cdp.send("Page.navigateToHistoryEntry", {
				entryId: entry.id,
			});
			return { ok: true, messages: [`navigated back to ${entry.url}`] };
		}
		return { ok: false, error: "no previous history entry" };
	}

	if (action.action === "forward") {
		const history = (await cdp.send("Page.getNavigationHistory", {})) as {
			currentIndex: number;
			entries: Array<{ id: number; url: string }>;
		};
		if (history.currentIndex < history.entries.length - 1) {
			const entry = history.entries[history.currentIndex + 1];
			await cdp.send("Page.navigateToHistoryEntry", {
				entryId: entry.id,
			});
			return { ok: true, messages: [`navigated forward to ${entry.url}`] };
		}
		return { ok: false, error: "no forward history entry" };
	}

	// URL navigation
	const result = (await cdp.send("Page.navigate", {
		url: action.url,
	})) as { frameId: string; errorText?: string };

	if (result.errorText) {
		return { ok: false, error: `navigation failed: ${result.errorText}` };
	}

	return { ok: true, messages: [`navigated to ${action.url}`] };
}

async function handleScreenshot(
	session: Session,
	filePath?: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const result = (await cdp.send("Page.captureScreenshot", {
		format: "png",
	})) as { data: string };

	if (filePath) {
		const fsPromises = await import("node:fs/promises");
		const buffer = Buffer.from(result.data, "base64");
		await fsPromises.writeFile(filePath, buffer);
		return {
			ok: true,
			messages: [`screenshot saved to ${filePath} (${buffer.length} bytes)`],
		};
	}

	// Return base64 data for agent consumption
	return { ok: true, data: result.data, messages: ["screenshot captured"] };
}

async function handleClick(
	session: Session,
	selector: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (!selector) {
		return { ok: false, error: "selector required" };
	}

	try {
		// Get document root
		const doc = (await cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		// Find element
		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Get box model for click coordinates
		const box = (await cdp.send("DOM.getBoxModel", {
			nodeId: found.nodeId,
		})) as { model: { content: number[] } };

		// content quad: [x1,y1, x2,y1, x2,y2, x1,y2]
		const quad = box.model.content;
		const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
		const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

		// Dispatch mouse events
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y,
		});
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			clickCount: 1,
		});

		return {
			ok: true,
			messages: [`clicked ${selector} at (${Math.round(x)}, ${Math.round(y)})`],
		};
	} catch (e) {
		return { ok: false, error: `click failed: ${(e as Error).message}` };
	}
}

async function handleType(
	session: Session,
	selector: string,
	text: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (!selector) {
		return { ok: false, error: 'usage: type "selector" "text"' };
	}

	try {
		// Get document and find element
		const doc = (await cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Focus the element
		await cdp.send("DOM.focus", { nodeId: found.nodeId });

		// Type each character
		for (const char of text) {
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				text: char,
			});
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				text: char,
			});
		}

		return {
			ok: true,
			messages: [`typed ${text.length} chars into ${selector}`],
		};
	} catch (e) {
		return { ok: false, error: `type failed: ${(e as Error).message}` };
	}
}

async function handleSelect(
	session: Session,
	selector: string,
	value: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (!selector) {
		return { ok: false, error: 'usage: select "selector" "value"' };
	}

	try {
		// Find element and set value via Runtime
		const doc = (await cdp.send("DOM.getDocument", {
			depth: 0,
		})) as { root: { nodeId: number } };

		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector,
		})) as { nodeId: number };

		if (!found.nodeId) {
			return { ok: false, error: `no element matches: ${selector}` };
		}

		// Resolve to JS object
		const resolved = (await cdp.send("DOM.resolveNode", {
			nodeId: found.nodeId,
		})) as { object: { objectId: string } };

		// Set value and dispatch change event
		const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		await cdp.send("Runtime.callFunctionOn", {
			objectId: resolved.object.objectId,
			functionDeclaration: `function() { this.value = '${escapedValue}'; this.dispatchEvent(new Event('change', { bubbles: true })); this.dispatchEvent(new Event('input', { bubbles: true })); }`,
			returnByValue: true,
		});

		return {
			ok: true,
			messages: [`selected "${value}" in ${selector}`],
		};
	} catch (e) {
		return { ok: false, error: `select failed: ${(e as Error).message}` };
	}
}

// ─── Mock / Emulate / Throttle / Coverage ───

async function handleMock(
	session: Session,
	urlPattern: string,
	body: string,
	status?: number,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (!urlPattern || body === undefined) {
		return {
			ok: false,
			error: "usage: mock <url-pattern> <json-body> [--status <code>]",
		};
	}

	const statusCode = status ?? 200;

	// Add mock rule
	cdp.addMockRule(urlPattern, body, statusCode);

	// Enable Fetch interception if not already enabled
	try {
		await cdp.send("Fetch.enable", {
			patterns: [{ urlPattern: "*" }],
		});
	} catch {
		// May already be enabled
	}

	return {
		ok: true,
		messages: [`mocking ${urlPattern} → ${statusCode} (${body.length} chars)`],
	};
}

async function handleUnmock(
	session: Session,
	pattern?: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	if (pattern) {
		const removed = cdp.removeMockRule(pattern);
		if (!removed) {
			return { ok: false, error: `no mock rule for: ${pattern}` };
		}
		if (cdp.getMockRules().size === 0) {
			try {
				await cdp.send("Fetch.disable", {});
			} catch {
				// ignore
			}
		}
		return { ok: true, messages: [`removed mock for ${pattern}`] };
	}

	// Clear all
	cdp.clearMockRules();
	try {
		await cdp.send("Fetch.disable", {});
	} catch {
		// ignore
	}
	return { ok: true, messages: ["all mocks cleared"] };
}

async function handleEmulate(
	session: Session,
	presetRaw: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const preset = presetRaw.trim().toLowerCase();

	if (preset === "reset") {
		await cdp.send("Emulation.clearDeviceMetricsOverride", {});
		return { ok: true, messages: ["emulation reset"] };
	}

	// Device presets
	const devices: Record<
		string,
		{
			width: number;
			height: number;
			scale: number;
			mobile: boolean;
			ua: string;
		}
	> = {
		"iphone-14": {
			width: 390,
			height: 844,
			scale: 3,
			mobile: true,
			ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
		},
		"iphone-se": {
			width: 375,
			height: 667,
			scale: 2,
			mobile: true,
			ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
		},
		ipad: {
			width: 810,
			height: 1080,
			scale: 2,
			mobile: true,
			ua: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
		},
		"pixel-7": {
			width: 412,
			height: 915,
			scale: 2.625,
			mobile: true,
			ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
		},
	};

	const device = devices[preset];
	if (!device) {
		const available = Object.keys(devices).join(", ");
		return {
			ok: false,
			error: `unknown device: ${preset}. Available: ${available}, reset`,
		};
	}

	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: device.width,
		height: device.height,
		deviceScaleFactor: device.scale,
		mobile: device.mobile,
	});
	await cdp.send("Emulation.setUserAgentOverride", {
		userAgent: device.ua,
	});
	await cdp.send("Emulation.setTouchEmulationEnabled", {
		enabled: device.mobile,
	});

	return {
		ok: true,
		messages: [`emulating ${preset} (${device.width}x${device.height})`],
	};
}

async function handleThrottle(
	session: Session,
	presetRaw: string,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}

	const preset = presetRaw.trim().toLowerCase();

	const presets: Record<
		string,
		{ latency: number; download: number; upload: number }
	> = {
		"3g": { latency: 100, download: 750 * 1024, upload: 250 * 1024 },
		"slow-3g": { latency: 2000, download: 50 * 1024, upload: 50 * 1024 },
		"fast-3g": {
			latency: 562,
			download: 180 * 1024,
			upload: 84.375 * 1024,
		},
		"4g": {
			latency: 20,
			download: 4 * 1024 * 1024,
			upload: 3 * 1024 * 1024,
		},
		offline: { latency: 0, download: 0, upload: 0 },
		off: { latency: 0, download: -1, upload: -1 },
	};

	const conditions = presets[preset];
	if (!conditions) {
		const available = Object.keys(presets).join(", ");
		return {
			ok: false,
			error: `unknown preset: ${preset}. Available: ${available}`,
		};
	}

	await cdp.send("Network.emulateNetworkConditions", {
		offline: preset === "offline",
		latency: conditions.latency,
		downloadThroughput: conditions.download,
		uploadThroughput: conditions.upload,
	});

	return {
		ok: true,
		messages: [
			preset === "off"
				? "network throttling disabled"
				: `network throttled to ${preset}`,
		],
	};
}

async function handleCoverage(
	session: Session,
	action: import("@dbg/types").CoverageAction,
): Promise<Response> {
	const cdp = asCdpExecutor(session);
	if (!cdp) {
		return { ok: false, error: "requires browser session" };
	}
	if (!session.state.connected) {
		return { ok: false, error: "not connected" };
	}
	if (!session.state.cdp) {
		return { ok: false, error: "missing cdp state" };
	}

	if (action === "start") {
		session.state.cdp.coverageSnapshot = null;
		try {
			await cdp.send("Profiler.enable", {});
			await cdp.send("Profiler.startPreciseCoverage", {
				callCount: true,
				detailed: true,
			});
		} catch {
			// ignore profiler errors
		}
		try {
			await cdp.send("CSS.startRuleUsageTracking", {});
		} catch {
			// ignore CSS errors
		}
		return { ok: true, messages: ["coverage tracking started"] };
	}

	if (action === "stop") {
		let jsSnapshot: JsCoverageScript[] = [];
		let cssSnapshot: CssCoverageEntry[] = [];

		try {
			const jsResult = (await cdp.send("Profiler.takePreciseCoverage", {})) as {
				result: JsCoverageScript[];
			};
			jsSnapshot = jsResult.result ?? [];
		} catch {
			// ignore
		}
		try {
			const cssResult = (await cdp.send("CSS.takeCoverageDelta", {})) as {
				coverage: CssCoverageEntry[];
			};
			cssSnapshot = cssResult.coverage ?? [];
		} catch {
			// ignore
		}

		session.state.cdp.coverageSnapshot = {
			js: jsSnapshot,
			css: cssSnapshot,
			capturedAt: Date.now(),
		};

		try {
			await cdp.send("Profiler.stopPreciseCoverage", {});
			await cdp.send("Profiler.disable", {});
		} catch {
			// ignore
		}
		try {
			await cdp.send("CSS.stopRuleUsageTracking", {});
		} catch {
			// ignore
		}
		return {
			ok: true,
			messages: [
				"coverage tracking stopped (query coverage table for results)",
			],
		};
	}

	return { ok: false, error: "usage: coverage start|stop" };
}

// ─── Query ───

async function handleQuery(
	queryStr: string,
	session: Session | null,
	cwd?: string,
): Promise<Response> {
	// Scope dev tables (commits/agent_prompts/agent_sessions/timeline) to the
	// CLIENT's cwd for the duration of this query, then restore.
	setScopeCwd(cwd ?? null);
	try {
		let executor: DebugExecutor;
		if (session) {
			executor = session.executor;
		} else if (registry.sessions.size > 0) {
			const first = registry.sessions.values().next().value;
			executor = first
				? first.executor
				: new CdpClientWrapper(createState(), store);
		} else {
			const emptyState = createState();
			executor = new CdpClientWrapper(emptyState, store);
		}

		const result = await executeQuery(queryStr, executor, tableRegistry);
		return { ok: true, columns: result.columns, rows: result.rows };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	} finally {
		setScopeCwd(null);
	}
}

async function handleMemoryCommand(
	session: Session,
	address: string,
	length: number,
): Promise<Response> {
	if (!address) {
		return { ok: false, error: "usage: memory <address> <length>" };
	}
	if (!Number.isFinite(length) || length <= 0) {
		return { ok: false, error: "length must be a positive integer" };
	}
	return handleQuery(
		`SELECT * FROM memory WHERE address = '${address}' AND length = ${length}`,
		session,
	);
}

async function handleDisasmCommand(
	session: Session,
	address?: string,
): Promise<Response> {
	if (!address) {
		const frame = session.state.callFrames[0];
		// Prefer instructionAddress (actual memory address) over scriptId (file path in DAP)
		const frameAddress = frame?.instructionAddress ?? frame?.scriptId;
		if (!frameAddress || looksLikeFilePath(frameAddress)) {
			return { ok: false, error: "usage: disasm <address>" };
		}
		return handleQuery(
			`SELECT * FROM disassembly WHERE address = '${frameAddress}' LIMIT 32`,
			session,
		);
	}
	return handleQuery(
		`SELECT * FROM disassembly WHERE address = '${address}' LIMIT 32`,
		session,
	);
}

function looksLikeFilePath(value: string): boolean {
	return (
		value.startsWith("/") || value.startsWith("\\") || value.includes("://")
	);
}

// ─── Dispatch ───

async function dispatch(cmd: Command): Promise<Response> {
	// Global (session-agnostic) commands first.
	switch (cmd.cmd) {
		case "devices":
			return handleDevices(cmd.platform);
		case "apps":
			return handleApps(cmd.deviceId);
		case "ss":
			return handleSessions();
		case "use":
			return handleUse(cmd.name);
		case "targets":
			return handleTargets(cmd.port, cmd.host);
		case "record.start":
			return handleRecordStart(cmd.urls, cmd.viewport, cmd.idleThresholdMs, {
				maxFrames: cmd.maxFrames,
				maxBytes: cmd.maxBytes,
				eventsTtlMs: cmd.eventsTtlMs,
			});
		case "record.stop":
			return handleRecordStop();
		case "record.status":
			return handleRecordStatus();
		case "record.mark":
			return handleRecordMark(cmd.name);
		case "record.after":
			return handleRecordAfter(cmd.at, cmd.open, {
				noNetwork: cmd.noNetwork,
				noState: cmd.noState,
				noA11y: cmd.noA11y,
				noPerf: cmd.noPerf,
			});
		case "record.timeline":
			return handleRecordTimeline(cmd.open, cmd.limit);
		case "record.replay":
			return handleRecordReplay(cmd.capture);
		case "record.shoot":
			return handleRecordShoot(cmd);
		case "why":
			return handleWhy(cmd.substring, cmd.cwd);
		case "tap.list":
			return handleTapList();
		case "tap.hits":
			return handleTapHits(cmd.id, cmd.tail);
		case "tap.rm":
			return handleTapRm(cmd.id);
		case "flow.record":
			return handleFlowRecord(cmd.name, cmd.url);
		case "flow.stop":
			return handleFlowStop();
		case "flow.list":
			return handleFlowList();
		case "flow.show":
			return handleFlowShow(cmd.name);
		case "flow.run":
			return handleFlowRun(cmd.name, cmd.stepTimeoutMs);
	}

	// Session-scoped commands share an optional `session` field.
	const sessionName = cmd.session;

	switch (cmd.cmd) {
		case "open":
			return handleOpen(cmd, sessionName);
		case "attach-lldb":
			return handleAttachLldb(cmd.program, cmd.args, sessionName);
		case "attach":
			return handleAttach(cmd, sessionName);
		case "run":
			return handleRun(cmd.command, sessionName);
		default: {
			// Commands that work without sessions
			if (cmd.cmd === "close" && registry.sessions.size === 0) {
				return { ok: true, messages: ["no sessions to close"] };
			}
			if (cmd.cmd === "status" && registry.sessions.size === 0) {
				return { ok: true, connected: false };
			}
			if (cmd.cmd === "health" && registry.sessions.size === 0) {
				return { ok: false, error: "not connected" };
			}
			if (cmd.cmd === "q") {
				if (sessionName && !registry.sessions.has(sessionName)) {
					return { ok: false, error: `unknown session: ${sessionName}` };
				}
				return handleQuery(cmd.sql, resolveSession(sessionName), cmd.cwd);
			}

			const session = resolveSession(sessionName);
			if (!session) {
				if (registry.sessions.size === 0) {
					return {
						ok: false,
						error: "no active session; use open or run first",
					};
				}
				return {
					ok: false,
					error: "multiple sessions; specify @name or use <name>",
				};
			}

			return dispatchToSession(cmd, session);
		}
	}
}

async function dispatchToSession(
	cmd: Command,
	session: Session,
): Promise<Response> {
	switch (cmd.cmd) {
		case "close":
			return handleClose(session);
		case "restart":
			return handleRestart(session);
		case "status":
			return handleStatus(session.executor, session.state);
		case "c":
			return handleContinue(session.executor, session.state);
		case "s":
			return handleStepInto(session.executor, session.state);
		case "n":
			return handleStepOver(session.executor, session.state);
		case "o":
			return handleStepOut(session.executor, session.state);
		case "pause":
			return handlePause(session.executor, session.state);
		case "b":
			return handleSetBreakpoint(
				session.executor,
				session.state,
				cmd.file,
				cmd.line,
				cmd.condition,
			);
		case "tap.add":
			return handleTapAdd(session, cmd.file, cmd.line, cmd.expr, cmd.url);
		case "db":
			return handleDeleteBreakpoint(session.executor, session.state, cmd.id);
		case "bl":
			return handleListBreakpoints(session.executor, session.state);
		case "e":
			return handleEval(session.executor, session.state, cmd.expression);
		case "src":
			return handleSource(
				session.executor,
				session.state,
				cmd.file,
				cmd.start,
				cmd.end,
			);
		case "trace":
			return handleTrace(store, cmd.limit);
		case "health":
			return handleHealth(session.executor, session.state);
		case "reconnect":
			return handleReconnect(
				session.executor,
				session.state,
				store,
				session.targetType === "native" ? undefined : session.targetType,
			);
		case "q":
			return handleQuery(cmd.sql, session, cmd.cwd);
		case "navigate":
			if (!session.executor.capabilities.page) {
				return { ok: false, error: "requires browser session" };
			}
			return handleNavigate(session, cmd.action);
		case "screenshot":
			if (!session.executor.capabilities.page) {
				return { ok: false, error: "requires browser session" };
			}
			return handleScreenshot(session, cmd.path);
		case "click":
			if (!session.executor.capabilities.dom) {
				return { ok: false, error: "requires browser session" };
			}
			return handleClick(session, cmd.selector);
		case "type":
			if (!session.executor.capabilities.dom) {
				return { ok: false, error: "requires browser session" };
			}
			return handleType(session, cmd.selector, cmd.text);
		case "select":
			if (!session.executor.capabilities.dom) {
				return { ok: false, error: "requires browser session" };
			}
			return handleSelect(session, cmd.selector, cmd.value);
		case "mock":
			if (!session.executor.capabilities.network) {
				return { ok: false, error: "requires browser session" };
			}
			return handleMock(session, cmd.urlPattern, cmd.body, cmd.status);
		case "unmock":
			if (!session.executor.capabilities.network) {
				return { ok: false, error: "requires browser session" };
			}
			return handleUnmock(session, cmd.pattern);
		case "emulate":
			if (!session.executor.capabilities.emulation) {
				return { ok: false, error: "requires browser session" };
			}
			return handleEmulate(session, cmd.preset);
		case "throttle":
			if (!session.executor.capabilities.network) {
				return { ok: false, error: "requires browser session" };
			}
			return handleThrottle(session, cmd.preset);
		case "coverage":
			if (!session.executor.capabilities.coverage) {
				return { ok: false, error: "requires browser session" };
			}
			return handleCoverage(session, cmd.action);
		case "registers":
			if (!session.executor.capabilities.registers) {
				return { ok: false, error: "requires LLDB session" };
			}
			return handleQuery("SELECT * FROM registers", session);
		case "memory":
			if (!session.executor.capabilities.memory) {
				return { ok: false, error: "requires LLDB session" };
			}
			return handleMemoryCommand(session, cmd.address, cmd.length);
		case "disasm":
			if (!session.executor.capabilities.disassembly) {
				return { ok: false, error: "requires LLDB session" };
			}
			return handleDisasmCommand(session, cmd.address);
		default:
			return {
				ok: false,
				error: `unknown command: ${(cmd as { cmd: string }).cmd}`,
			};
	}
}

// ─── Socket server ───

function startServer(): void {
	// Atomic bind-or-defer. Concurrent CLI invocations can race the daemon
	// auto-spawn and fork several daemons at once; the old unlink-then-listen
	// here let every newcomer DELETE a healthy daemon's socket and usurp it,
	// orphaning the previous daemon with all its session state (split-brain).
	// Now: bind without unlinking. On EADDRINUSE, probe the existing socket —
	// a live daemon answers, so this process defers and exits; only a dead
	// (stale) socket file is unlinked, and takeover is retried exactly once.
	let boundSocket = false;
	let attemptedStaleTakeover = false;

	const server = net.createServer((socket) => {
		let buffer = "";

		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			// Process complete lines
			while (true) {
				const newlineIdx = buffer.indexOf("\n");
				if (newlineIdx === -1) break;
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				if (!line.trim()) continue;
				processLine(socket, line);
			}
		});

		socket.on("error", () => {
			// Client disconnected, ignore
		});
	});

	const deferToExistingDaemon = () => {
		// Another daemon owns the socket. Flush our scratch events and bow out.
		store.close();
		process.exit(0);
	};

	const tryListen = () => {
		server.listen(SOCKET_PATH, () => {
			boundSocket = true;
			// Write PID to stdout so the CLI knows we launched
			process.stdout.write(`${process.pid}\n`);
			// Detach stdout/stderr after writing PID
			if (process.stdout.unref) process.stdout.unref();
		});
	};

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			const probe = net.createConnection(SOCKET_PATH);
			probe.on("connect", () => {
				probe.destroy();
				deferToExistingDaemon();
			});
			probe.on("error", () => {
				probe.destroy();
				if (attemptedStaleTakeover) {
					// Lost the takeover race to a sibling that is now binding;
					// treat it as the live daemon and defer.
					deferToExistingDaemon();
					return;
				}
				attemptedStaleTakeover = true;
				try {
					fs.unlinkSync(SOCKET_PATH);
				} catch {
					// already gone
				}
				tryListen();
			});
			probe.setTimeout(1000, () => {
				// Busy-but-alive daemon: defer rather than usurp.
				probe.destroy();
				deferToExistingDaemon();
			});
			return;
		}
		process.stderr.write(`daemon server error: ${err.message}\n`);
		process.exit(1);
	});

	tryListen();

	// Cleanup on exit
	function cleanup() {
		store.record(
			{
				source: "daemon",
				category: "lifecycle",
				method: "daemon.stop",
				data: { pid: process.pid },
			},
			true,
		);
		// Only the daemon that actually bound the socket may remove the file —
		// a deferring loser must never delete the winner's socket.
		if (boundSocket) {
			try {
				fs.unlinkSync(SOCKET_PATH);
			} catch {
				// ignore
			}
		}
		if (recorder) {
			recorder.watcher?.close();
			// cleanup() is synchronous; kick off SIGTERM→SIGKILL without awaiting.
			void recorder.chrome.kill();
			recorder = null;
		}
		if (pendingChrome) {
			void pendingChrome.kill();
			pendingChrome = null;
		}
		if (shootChrome) {
			void shootChrome.kill();
			shootChrome = null;
		}
		for (const session of registry.sessions.values()) {
			if (session.managedChild) {
				killTarget(session.managedChild);
			}
			void (
				session.executor as {
					disconnect?: () => Promise<void>;
				}
			).disconnect?.();
		}
		registry.sessions.clear();
		store.close();
		server.close();
	}

	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("uncaughtException", (err) => {
		process.stderr.write(`daemon uncaught: ${err.message}\n`);
		cleanup();
		process.exit(1);
	});
}

function parseErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return undefined;
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && code ? code : undefined;
}

function processLine(socket: net.Socket, line: string): void {
	let cmd: Command;
	try {
		cmd = JSON.parse(line) as Command;
	} catch {
		sendResponse(socket, { ok: false, error: "invalid JSON" });
		return;
	}

	dispatch(cmd)
		.then((response) => {
			sendResponse(socket, response);
		})
		.catch((err) => {
			sendResponse(socket, {
				ok: false,
				error: `dispatch error: ${(err as Error).message}`,
			});
		});
}

function sendResponse(socket: net.Socket, response: Response): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// Client already gone
	}
}

// ─── Entry point ───

startServer();
