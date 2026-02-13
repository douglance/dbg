// CDP target discovery: find the WebSocket debugger URL for a debuggable target

import http from "node:http";

interface TargetInfo {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl: string;
}

export type TargetType = "node" | "page";

export interface TargetListEntry {
	id: string;
	type: string;
	title: string;
	url: string;
}

export function listTargets(
	port: number,
	host = "127.0.0.1",
): Promise<TargetListEntry[]> {
	return new Promise((resolve, reject) => {
		const req = http.get(`http://${host}:${port}/json`, (res) => {
			let body = "";
			res.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			res.on("end", () => {
				try {
					const targets = JSON.parse(body) as TargetInfo[];
					resolve(
						targets
							.filter((t) => t.webSocketDebuggerUrl)
							.map((t) => ({
								id: t.id,
								type: t.type,
								title: t.title,
								url: t.url,
							})),
					);
				} catch (e) {
					reject(
						new Error(
							`failed to parse /json response: ${(e as Error).message}`,
						),
					);
				}
			});
		});
		req.on("error", (e) => {
			reject(
				new Error(`cannot reach debugger at ${host}:${port}: ${e.message}`),
			);
		});
		req.setTimeout(5000, () => {
			req.destroy();
			reject(new Error(`timeout connecting to ${host}:${port}`));
		});
	});
}

export interface DiscoveredTarget {
	wsUrl: string;
	type: TargetType;
}

export function discoverTarget(
	port: number,
	host = "127.0.0.1",
	targetType?: TargetType,
): Promise<DiscoveredTarget> {
	return new Promise((resolve, reject) => {
		const req = http.get(`http://${host}:${port}/json`, (res) => {
			let body = "";
			res.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			res.on("end", () => {
				try {
					const targets = JSON.parse(body) as TargetInfo[];

					if (targetType) {
						// Explicit type requested
						const target = targets.find(
							(t) => t.type === targetType && t.webSocketDebuggerUrl,
						);
						if (!target) {
							reject(
								new Error(
									`no debuggable ${targetType} target on ${host}:${port}`,
								),
							);
							return;
						}
						resolve({ wsUrl: target.webSocketDebuggerUrl, type: targetType });
						return;
					}

					// Auto-detect: try node first, fall back to page
					const nodeTarget = targets.find(
						(t) => t.type === "node" && t.webSocketDebuggerUrl,
					);
					if (nodeTarget) {
						resolve({ wsUrl: nodeTarget.webSocketDebuggerUrl, type: "node" });
						return;
					}

					const pageTarget = targets.find(
						(t) => t.type === "page" && t.webSocketDebuggerUrl,
					);
					if (pageTarget) {
						resolve({ wsUrl: pageTarget.webSocketDebuggerUrl, type: "page" });
						return;
					}

					reject(new Error(`no debuggable target on ${host}:${port}`));
				} catch (e) {
					reject(
						new Error(
							`failed to parse /json response: ${(e as Error).message}`,
						),
					);
				}
			});
		});
		req.on("error", (e) => {
			reject(
				new Error(`cannot reach debugger at ${host}:${port}: ${e.message}`),
			);
		});
		req.setTimeout(5000, () => {
			req.destroy();
			reject(new Error(`timeout connecting to ${host}:${port}`));
		});
	});
}
