// App-state diff for `dbg after`: compare local/sessionStorage entries at the
// anchor vs after, emitting added/removed/changed keys. Values are JSON-parsed
// when they parse (so structured storage diffs read cleanly). Pure.

export type StorageKind = "localStorage" | "sessionStorage";

export interface StorageSnapshot {
	localStorage: Record<string, string>;
	sessionStorage: Record<string, string>;
}

export interface StateChange {
	kind: StorageKind;
	key: string;
	change: "added" | "removed" | "changed";
	before: unknown;
	after: unknown;
}

function parseMaybe(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function diffKind(
	kind: StorageKind,
	before: Record<string, string>,
	after: Record<string, string>,
): StateChange[] {
	const changes: StateChange[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const hasBefore = Object.hasOwn(before, key);
		const hasAfter = Object.hasOwn(after, key);
		if (hasBefore && !hasAfter) {
			changes.push({
				kind,
				key,
				change: "removed",
				before: parseMaybe(before[key]),
				after: undefined,
			});
		} else if (!hasBefore && hasAfter) {
			changes.push({
				kind,
				key,
				change: "added",
				before: undefined,
				after: parseMaybe(after[key]),
			});
		} else if (before[key] !== after[key]) {
			changes.push({
				kind,
				key,
				change: "changed",
				before: parseMaybe(before[key]),
				after: parseMaybe(after[key]),
			});
		}
	}
	return changes.sort((a, b) => a.key.localeCompare(b.key));
}

export function diffStorage(
	before: StorageSnapshot,
	after: StorageSnapshot,
): StateChange[] {
	return [
		...diffKind("localStorage", before.localStorage, after.localStorage),
		...diffKind("sessionStorage", before.sessionStorage, after.sessionStorage),
	];
}
