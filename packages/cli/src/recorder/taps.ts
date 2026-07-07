// Taps = logpoints: a conditioned breakpoint that never pauses, emitting an
// expression value through a console sentinel. Pure helpers for building the
// condition, deriving the URL regex, and parsing the sentinel back out.

/** Console sentinel prefix; the first console.log arg is `${PREFIX}${tapId}`. */
export const TAP_SENTINEL_PREFIX = "__dbg_tap:";

/**
 * DevTools logpoint trick: a breakpoint whose condition has a side effect
 * (console.log) and evaluates to a falsy value (`void ...`) never pauses. The
 * expression is wrapped so a throw becomes a "tap-expr-error:" string rather
 * than silently disarming the log.
 */
export function buildTapCondition(tapId: number, expr: string): string {
	return `void console.log(${JSON.stringify(`${TAP_SENTINEL_PREFIX}${tapId}`)}, (()=>{try{return (${expr})}catch(e){return "tap-expr-error:"+e}})())`;
}

/**
 * URL regex for Debugger.setBreakpointByUrl from a right-aligned file suffix.
 * Users pass the path as their dev server serves it (e.g. `src/Foo.tsx` for a
 * Vite server serving `/src/Foo.tsx`); a leading `./` or `/` is stripped and the
 * rest is escaped. CDP matches the regex as a substring of the script URL, so a
 * suffix naturally right-aligns and tolerates a trailing `?t=…` query. Bundles
 * (where the served URL doesn't contain the source path) use `--url` instead.
 */
export function suffixUrlRegex(file: string): string {
	const cleaned = file.replace(/^\.?\//, "");
	return cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RemoteObjectLike {
	type?: string;
	value?: unknown;
	description?: string;
	unserializableValue?: string;
}

/** Best-effort readable string for a CDP RemoteObject (the tapped value). */
export function remoteObjectToString(obj: unknown): string {
	if (typeof obj !== "object" || obj === null) return String(obj);
	const ro = obj as RemoteObjectLike;
	if (ro.value !== undefined) {
		return typeof ro.value === "string" ? ro.value : JSON.stringify(ro.value);
	}
	if (typeof ro.unserializableValue === "string") return ro.unserializableValue;
	if (typeof ro.description === "string") return ro.description;
	return typeof ro.type === "string" ? `[${ro.type}]` : "";
}

/**
 * Parse a console.consoleAPICalled args array. Returns the tap id + stringified
 * value when the first arg is the tap sentinel, else null (not a tap row).
 */
export function parseTapSentinel(
	args: unknown,
): { tapId: number; value: string } | null {
	if (!Array.isArray(args) || args.length === 0) return null;
	const first = args[0] as RemoteObjectLike;
	if (typeof first?.value !== "string") return null;
	if (!first.value.startsWith(TAP_SENTINEL_PREFIX)) return null;
	const tapId = Number(first.value.slice(TAP_SENTINEL_PREFIX.length));
	if (!Number.isInteger(tapId)) return null;
	const value = args.length > 1 ? remoteObjectToString(args[1]) : "";
	return { tapId, value };
}
