import type { CdpExecutor } from "../../protocol.js";
import { extractFilterValue } from "./utils.js";

import type { VirtualTable } from "./index.js";

type DetailMode = "compact" | "standard" | "full";
type IncludeMode = "all" | "errors" | "network" | "debugger" | "browser";
type Severity = "trace" | "info" | "warn" | "error";

interface TimelineRow {
	id: number;
	ts: number;
	stream: string;
	phase: string;
	entity: string;
	method: string;
	summary: string;
	severity: Severity;
	durationMs: number | null;
	sessionId: string | null;
	rawRef: string;
}

interface EventRecord {
	id: number;
	ts: number;
	source: string;
	category: string;
	method: string;
	data: unknown;
	sessionId: string | null;
}

const MAX_SCAN_ROWS = 1500;

export const timelineTable: VirtualTable = {
	name: "timeline",
	columns: [
		"id",
		"ts",
		"stream",
		"phase",
		"entity",
		"method",
		"summary",
		"severity",
		"duration_ms",
		"session_id",
		"raw_ref",
		"detail",
		"include",
		"window_ms",
	],
	async fetch(where, executor) {
		const store = executor.getStore?.();
		if (!store) {
			return { columns: this.columns, rows: [] };
		}

		const detail = parseDetail(extractFilterValue(where, "detail"));
		const include = parseInclude(extractFilterValue(where, "include"));
		const windowMs = parseWindowMs(extractFilterValue(where, "window_ms"));

		const records = store
			.query(
				`SELECT id, ts, source, category, method, data, session_id
				 FROM events
				 ORDER BY id DESC
				 LIMIT ${MAX_SCAN_ROWS}`,
			)
			.reverse()
			.map(normalizeEventRecord);

		let rows = records.map((record) => toTimelineRow(record, detail));
		rows = applyIncludeFilter(rows, include);

		if (detail === "compact") {
			rows = stripCompactNoise(rows);
		}

		rows = applyWindow(rows, windowMs);

		if (detail === "compact") {
			rows = coalesceRows(rows);
		}

		return {
			columns: this.columns,
			rows: rows.map((row) => [
				row.id,
				row.ts,
				row.stream,
				row.phase,
				row.entity,
				row.method,
				row.summary,
				row.severity,
				row.durationMs,
				row.sessionId,
				row.rawRef,
				detail,
				include,
				windowMs,
			]),
		};
	},
};

function normalizeEventRecord(row: Record<string, unknown>): EventRecord {
	return {
		id: asNumber(row.id, 0),
		ts: asNumber(row.ts, Date.now()),
		source: asString(row.source),
		category: asString(row.category),
		method: normalizeMethod(asString(row.method)),
		data: parsePayload(row.data),
		sessionId: asNullableString(row.session_id),
	};
}

function toTimelineRow(record: EventRecord, detail: DetailMode): TimelineRow {
	const stream = classifyStream(record);
	const phase = classifyPhase(record);
	const severity = classifySeverity(record, stream);
	const entity = extractEntity(record);
	const durationMs = extractDurationMs(record.data);
	const summary = truncate(
		buildSummary(record, stream, phase, entity, durationMs),
		maxSummaryChars(detail),
	);

	return {
		id: record.id,
		ts: record.ts,
		stream,
		phase,
		entity,
		method: record.method,
		summary,
		severity,
		durationMs,
		sessionId: record.sessionId,
		rawRef: `events:${record.id}`,
	};
}

function classifyStream(record: EventRecord): string {
	if (record.category === "connection") return "connection";
	if (record.category === "daemon") return "daemon";
	if (record.category !== "cdp") return record.category || "daemon";

	const method = record.method;
	if (method.startsWith("Network.webSocket")) return "ws";
	if (method.startsWith("Network.")) return "network";
	if (method.startsWith("Page.")) return "page";
	if (method.startsWith("Debugger.")) return "debugger";
	if (method === "Runtime.exceptionThrown") return "exception";
	if (method === "Runtime.consoleAPICalled" || method.startsWith("Log.")) {
		return "console";
	}
	if (method.startsWith("Runtime.")) return "debugger";
	if (method.startsWith("Profiler.") || method.startsWith("CSS.")) {
		return "coverage";
	}
	if (method.startsWith("Fetch.")) return "mock";
	if (
		method.startsWith("DOM.") ||
		method.startsWith("DOMStorage.") ||
		method.startsWith("Input.") ||
		method.startsWith("Emulation.")
	) {
		return "browser";
	}

	return "cdp";
}

function classifyPhase(record: EventRecord): string {
	const methodLower = record.method.toLowerCase();
	if (record.source === "cdp_send") return "request";
	if (record.source === "cdp_recv") {
		if (extractErrorText(record.data)) return "error";
		if (hasPath(record.data, ["event"])) return "event";
		return "response";
	}
	if (methodLower.endsWith(".start") || methodLower.endsWith("_start")) {
		return "start";
	}
	if (methodLower.endsWith(".stop") || methodLower.endsWith("_stop")) {
		return "stop";
	}
	if (methodLower.includes("error") || methodLower.includes("fail")) {
		return "error";
	}
	return "event";
}

function classifySeverity(record: EventRecord, stream: string): Severity {
	if (stream === "exception") return "error";
	if (extractErrorText(record.data)) return "error";

	const methodLower = record.method.toLowerCase();
	if (methodLower.includes("exception") || methodLower.includes("error")) {
		return "error";
	}
	if (methodLower.includes("warn") || consoleLevel(record.data) === "warning") {
		return "warn";
	}
	if (record.source === "cdp_send") return "trace";
	if (record.source === "cdp_recv" && stream === "cdp") return "trace";
	return "info";
}

function extractEntity(record: EventRecord): string {
	const payload = record.data;
	const directPaths: string[][] = [
		["event", "requestId"],
		["params", "requestId"],
		["response", "requestId"],
		["event", "frameId"],
		["params", "frameId"],
		["event", "styleSheetId"],
		["params", "styleSheetId"],
		["event", "scriptId"],
		["params", "scriptId"],
		["params", "breakpointId"],
		["response", "breakpointId"],
		["data", "wsUrl"],
		["params", "targetId"],
		["event", "targetInfo", "targetId"],
	];
	for (const path of directPaths) {
		const value = valueAtPath(payload, path);
		if (typeof value === "string" && value) return value;
	}

	const frameObj = valueAtPath(payload, ["event", "frame"]);
	if (isRecord(frameObj) && typeof frameObj.id === "string" && frameObj.id) {
		return frameObj.id;
	}

	const callFrames = valueAtPath(payload, ["event", "callFrames"]);
	if (Array.isArray(callFrames) && callFrames.length > 0) {
		const first = callFrames[0];
		if (isRecord(first) && typeof first.callFrameId === "string") {
			return first.callFrameId;
		}
	}

	return record.sessionId ?? "";
}

function extractDurationMs(payload: unknown): number | null {
	const candidates: string[][] = [
		["latencyMs"],
		["response", "latencyMs"],
		["event", "latencyMs"],
		["event", "duration"],
	];
	for (const path of candidates) {
		const value = valueAtPath(payload, path);
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return null;
}

function buildSummary(
	record: EventRecord,
	stream: string,
	phase: string,
	entity: string,
	durationMs: number | null,
): string {
	const payload = record.data;
	const error = extractErrorText(payload);
	const url = extractUrl(payload);
	const status = extractStatus(payload);
	const httpMethod = extractHttpMethod(payload);
	const type = extractResourceType(payload);

	switch (stream) {
		case "network": {
			const parts: string[] = [];
			if (httpMethod) parts.push(httpMethod);
			if (url) parts.push(shortenUrl(url));
			if (status !== null) parts.push(`-> ${status}`);
			if (type) parts.push(`[${type}]`);
			if (error) parts.push(`error: ${error}`);
			if (parts.length > 0) return parts.join(" ");
			break;
		}
		case "ws": {
			const opcode = valueAtPath(payload, ["event", "response", "opcode"]);
			const wsDirection =
				record.method.includes("Received") || phase === "response"
					? "recv"
					: record.method.includes("Sent")
						? "sent"
						: phase;
			if (typeof opcode === "number") {
				return `${wsDirection} opcode=${opcode}`;
			}
			return wsDirection;
		}
		case "console": {
			const message = extractConsoleText(payload);
			if (message) return message;
			break;
		}
		case "exception": {
			if (error) return `exception ${error}`;
			break;
		}
		case "connection": {
			const wsUrl =
				asMaybeString(valueAtPath(payload, ["wsUrl"])) ??
				asMaybeString(valueAtPath(payload, ["data", "wsUrl"]));
			if (wsUrl) return `${record.method} ${shortenUrl(wsUrl)}`;
			break;
		}
	}

	let summary = record.method;
	if (entity) summary += ` #${entity}`;
	if (durationMs !== null) summary += ` (${durationMs}ms)`;
	if (error) summary += ` error: ${error}`;

	const preview = payloadPreview(payload);
	if (!error && preview) summary += ` ${preview}`;
	return summary;
}

function applyIncludeFilter(
	rows: TimelineRow[],
	include: IncludeMode,
): TimelineRow[] {
	switch (include) {
		case "all":
			return rows;
		case "errors":
			return rows.filter((row) => row.severity === "error");
		case "network":
			return rows.filter(
				(row) => row.stream === "network" || row.stream === "ws",
			);
		case "debugger":
			return rows.filter(
				(row) => row.stream === "debugger" || row.stream === "exception",
			);
		case "browser":
			return rows.filter((row) =>
				[
					"network",
					"ws",
					"page",
					"console",
					"exception",
					"coverage",
					"mock",
				].includes(row.stream),
			);
	}
}

function applyWindow(rows: TimelineRow[], windowMs: number): TimelineRow[] {
	if (windowMs <= 0 || rows.length === 0) return rows;
	const latestErrorTs = rows.reduce<number | null>((acc, row) => {
		if (row.severity !== "error") return acc;
		if (acc === null || row.ts > acc) return row.ts;
		return acc;
	}, null);
	const anchorTs = latestErrorTs ?? rows[rows.length - 1].ts;
	return rows.filter((row) => Math.abs(row.ts - anchorTs) <= windowMs);
}

function stripCompactNoise(rows: TimelineRow[]): TimelineRow[] {
	return rows.filter((row) => !isCompactNoise(row.method));
}

function isCompactNoise(method: string): boolean {
	return (
		method === "Debugger.scriptParsed" ||
		method === "Runtime.executionContextCreated" ||
		method === "Runtime.executionContextDestroyed" ||
		method === "Runtime.executionContextsCleared"
	);
}

function coalesceRows(rows: TimelineRow[]): TimelineRow[] {
	if (rows.length <= 1) return rows;
	const output: Array<TimelineRow & { count: number }> = [];

	for (const row of rows) {
		const previous = output[output.length - 1];
		if (previous && canCoalesce(previous, row)) {
			previous.count += 1;
			previous.id = row.id;
			previous.ts = row.ts;
			previous.rawRef = mergeRawRefs(previous.rawRef, row.rawRef);
			if (row.durationMs !== null) previous.durationMs = row.durationMs;
			continue;
		}
		output.push({ ...row, count: 1 });
	}

	return output.map((row) => {
		if (row.count <= 1) return row;
		return {
			...row,
			summary: `${row.summary} (x${row.count})`,
		};
	});
}

function canCoalesce(previous: TimelineRow, current: TimelineRow): boolean {
	return (
		previous.severity !== "error" &&
		current.severity !== "error" &&
		previous.stream === current.stream &&
		previous.phase === current.phase &&
		previous.method === current.method &&
		previous.entity === current.entity &&
		previous.summary === current.summary &&
		previous.sessionId === current.sessionId
	);
}

function mergeRawRefs(first: string, second: string): string {
	const firstRange = parseRawRef(first);
	const secondRange = parseRawRef(second);
	if (!firstRange || !secondRange) return first;
	const start = Math.min(firstRange.start, secondRange.start);
	const end = Math.max(firstRange.end, secondRange.end);
	return start === end ? `events:${start}` : `events:${start}-${end}`;
}

function parseRawRef(rawRef: string): { start: number; end: number } | null {
	const single = rawRef.match(/^events:(\d+)$/);
	if (single) {
		const value = Number(single[1]);
		return { start: value, end: value };
	}
	const range = rawRef.match(/^events:(\d+)-(\d+)$/);
	if (range) {
		return { start: Number(range[1]), end: Number(range[2]) };
	}
	return null;
}

function extractHttpMethod(payload: unknown): string {
	return (
		asMaybeString(valueAtPath(payload, ["event", "request", "method"])) ??
		asMaybeString(valueAtPath(payload, ["params", "request", "method"])) ??
		""
	);
}

function extractUrl(payload: unknown): string {
	return (
		asMaybeString(valueAtPath(payload, ["event", "request", "url"])) ??
		asMaybeString(valueAtPath(payload, ["params", "request", "url"])) ??
		asMaybeString(valueAtPath(payload, ["event", "response", "url"])) ??
		asMaybeString(valueAtPath(payload, ["response", "url"])) ??
		asMaybeString(valueAtPath(payload, ["event", "url"])) ??
		""
	);
}

function extractStatus(payload: unknown): number | null {
	const value =
		valueAtPath(payload, ["event", "response", "status"]) ??
		valueAtPath(payload, ["response", "status"]);
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractResourceType(payload: unknown): string {
	return (
		asMaybeString(valueAtPath(payload, ["event", "type"])) ??
		asMaybeString(valueAtPath(payload, ["params", "type"])) ??
		""
	);
}

function consoleLevel(payload: unknown): string {
	return (
		asMaybeString(valueAtPath(payload, ["event", "type"])) ??
		asMaybeString(valueAtPath(payload, ["event", "entry", "level"])) ??
		""
	).toLowerCase();
}

function extractConsoleText(payload: unknown): string {
	const args = valueAtPath(payload, ["event", "args"]);
	if (Array.isArray(args) && args.length > 0) {
		return args
			.map((arg) => {
				if (!isRecord(arg)) return String(arg);
				if (arg.value !== undefined) return String(arg.value);
				if (typeof arg.description === "string") return arg.description;
				if (typeof arg.type === "string") return `[${arg.type}]`;
				return "";
			})
			.filter(Boolean)
			.join(" ");
	}

	return (
		asMaybeString(valueAtPath(payload, ["event", "entry", "text"])) ??
		asMaybeString(
			valueAtPath(payload, ["event", "exceptionDetails", "text"]),
		) ??
		""
	);
}

function extractErrorText(payload: unknown): string {
	const paths: string[][] = [
		["error"],
		["event", "errorText"],
		["response", "errorText"],
		["event", "exceptionDetails", "text"],
		["event", "exceptionDetails", "exception", "description"],
		["event", "entry", "text"],
	];
	for (const path of paths) {
		const value = valueAtPath(payload, path);
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function payloadPreview(payload: unknown): string {
	const candidate =
		valueAtPath(payload, ["event"]) ??
		valueAtPath(payload, ["params"]) ??
		valueAtPath(payload, ["response"]);
	if (candidate === undefined) return "";

	const asText = safeStringify(candidate);
	if (!asText || asText === "{}") return "";
	return asText;
}

function parseDetail(raw: string | number | null): DetailMode {
	if (raw === "standard" || raw === "full") return raw;
	return "compact";
}

function parseInclude(raw: string | number | null): IncludeMode {
	if (
		raw === "errors" ||
		raw === "network" ||
		raw === "debugger" ||
		raw === "browser"
	) {
		return raw;
	}
	return "all";
}

function parseWindowMs(raw: string | number | null): number {
	if (typeof raw === "number" && raw > 0) return Math.floor(raw);
	if (typeof raw === "string" && raw.trim()) {
		const parsed = Number(raw);
		if (!Number.isNaN(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return 0;
}

function maxSummaryChars(detail: DetailMode): number {
	switch (detail) {
		case "compact":
			return 160;
		case "standard":
			return 400;
		case "full":
			return Number.POSITIVE_INFINITY;
	}
}

function truncate(text: string, maxChars: number): string {
	if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function shortenUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const compact = `${parsed.origin}${parsed.pathname}`;
		return truncate(compact, 96);
	} catch {
		return truncate(url, 96);
	}
}

function asNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function normalizeMethod(method: string): string {
	return method.endsWith(".undefined") ? method.slice(0, -10) : method;
}

function asMaybeString(value: unknown): string | null {
	if (typeof value === "string" && value) return value;
	return null;
}

function asNullableString(value: unknown): string | null {
	if (typeof value === "string") return value;
	return null;
}

function parsePayload(raw: unknown): unknown {
	if (raw === null || raw === undefined) return {};
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return { text: raw };
		}
	}
	if (typeof raw === "object") return raw;
	return { value: raw };
}

function valueAtPath(root: unknown, path: string[]): unknown {
	let current: unknown = root;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function hasPath(root: unknown, path: string[]): boolean {
	return valueAtPath(root, path) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}
