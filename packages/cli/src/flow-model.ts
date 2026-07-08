export type FlowActionKind = "click" | "input" | "keypress" | "scroll" | "nav";

export interface ParsedFlowAction {
	kind: FlowActionKind;
	selector: string | null;
	fallbackPath: string | null;
	value: string | null;
}

const FLOW_KINDS = new Set<FlowActionKind>([
	"click",
	"input",
	"keypress",
	"scroll",
	"nav",
]);

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function parseFlowAction(payload: string): ParsedFlowAction | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const kind = record.kind;
	if (typeof kind !== "string" || !FLOW_KINDS.has(kind as FlowActionKind)) {
		return null;
	}
	return {
		kind: kind as FlowActionKind,
		selector: optionalString(record.selector),
		fallbackPath: optionalString(record.fallbackPath),
		value: optionalString(record.value),
	};
}
