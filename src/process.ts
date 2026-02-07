// Target process management: spawn with --inspect-brk, extract debug port

import { type ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";

export interface SpawnResult {
	child: ChildProcess;
	port: number;
}

/**
 * Spawn a target command with --inspect-brk injected.
 * Parses stderr to find the actual inspect port.
 * Returns once the debugger is listening.
 */
export async function spawnTarget(command: string): Promise<SpawnResult> {
	const parts = parseCommand(command);
	if (parts.length === 0) {
		throw new Error("empty command");
	}

	const [cmd, ...args] = parts;

	// Find a free port for --inspect-brk
	const inspectPort = await findFreePort();

	// Filter out any existing --inspect* flags from user's command
	const filteredArgs = args.filter((a) => !a.startsWith("--inspect"));
	const inspectArgs = [`--inspect-brk=${inspectPort}`, ...filteredArgs];

	const child = spawn(cmd, inspectArgs, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});

	return new Promise((resolve, reject) => {
		let stderrBuf = "";
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				reject(new Error("timeout waiting for debugger to listen"));
				child.kill();
			}
		}, 10000);

		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
			// Node prints: "Debugger listening on ws://127.0.0.1:PORT/..."
			const match = stderrBuf.match(
				/Debugger listening on ws:\/\/[\w.]+:(\d+)\//,
			);
			if (match && !resolved) {
				resolved = true;
				clearTimeout(timer);
				resolve({ child, port: Number.parseInt(match[1], 10) });
			}
		});

		child.on("error", (err) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				reject(new Error(`failed to spawn: ${err.message}`));
			}
		});

		child.on("exit", (code, signal) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				reject(
					new Error(
						`process exited before debugger ready: code=${code} signal=${signal}`,
					),
				);
			}
		});
	});
}

export function killTarget(child: ChildProcess): void {
	if (!child.killed) {
		child.kill("SIGTERM");
		// Force kill after 2 seconds if still alive
		setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGKILL");
			}
		}, 2000);
	}
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address() as net.AddressInfo;
			const port = addr.port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function parseCommand(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (const ch of command) {
		if (inQuote) {
			if (ch === inQuote) {
				inQuote = null;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === " " || ch === "\t") {
			if (current) {
				parts.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current) parts.push(current);
	return parts;
}
