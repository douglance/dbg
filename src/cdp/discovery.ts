// CDP target discovery: find the WebSocket debugger URL for a Node.js target

import http from "node:http";

interface TargetInfo {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl: string;
}

export function discoverTarget(
	port: number,
	host = "127.0.0.1",
): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = http.get(`http://${host}:${port}/json`, (res) => {
			let body = "";
			res.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			res.on("end", () => {
				try {
					const targets = JSON.parse(body) as TargetInfo[];
					const target = targets.find(
						(t) => t.type === "node" && t.webSocketDebuggerUrl,
					);
					if (!target) {
						reject(new Error(`no debuggable Node.js target on ${host}:${port}`));
						return;
					}
					resolve(target.webSocketDebuggerUrl);
				} catch (e) {
					reject(
						new Error(`failed to parse /json response: ${(e as Error).message}`),
					);
				}
			});
		});
		req.on("error", (e) => {
			reject(new Error(`cannot reach debugger at ${host}:${port}: ${e.message}`));
		});
		req.setTimeout(5000, () => {
			req.destroy();
			reject(new Error(`timeout connecting to ${host}:${port}`));
		});
	});
}
