// Vite HMR wire-tap parser (visual flight recorder, Phase 2).
//
// Given a raw WebSocket payload observed on a vite dev server's HMR channel,
// return the updated module paths. Pure and total: malformed, binary, or
// non-HMR payloads return [] — this function never throws.

export function parseHmrModules(payload: string): string[] {
	let message: unknown;
	try {
		message = JSON.parse(payload);
	} catch {
		return [];
	}
	if (typeof message !== "object" || message === null) return [];
	const msg = message as { type?: unknown; updates?: unknown; path?: unknown };

	// {"type":"update","updates":[{"path":"/src/App.tsx",...}, ...]}
	if (msg.type === "update" && Array.isArray(msg.updates)) {
		const paths: string[] = [];
		for (const update of msg.updates) {
			const p = (update as { path?: unknown } | null)?.path;
			if (typeof p === "string" && p.length > 0) paths.push(p);
		}
		return paths;
	}

	// {"type":"full-reload","path":"*"} — everything changed
	if (msg.type === "full-reload") {
		return [
			typeof msg.path === "string" && msg.path.length > 0 ? msg.path : "*",
		];
	}

	return [];
}
