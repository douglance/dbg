// Daemon lifecycle + socket client.
// Auto-spawns the background daemon when the socket is unreachable, falls
// back to a deterministic per-user/per-repo socket when the default is
// unhealthy, and wraps send/receive over a Unix socket as a typed
// one-command-in, one-response-out exchange.

import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command, Response } from "@dbg/types";

const DEFAULT_SOCKET_PATH = "/tmp/dbg.sock";
const DEFAULT_EVENTS_DB_PATH = "/tmp/dbg-events.db";

export interface DaemonPaths {
	socketPath: string;
	eventsDbPath: string;
	explicitSocket: boolean;
	explicitEventsDb: boolean;
	usingFallback: boolean;
}

export function resolveInitialDaemonPaths(): DaemonPaths {
	const envSocket = process.env.DBG_SOCK?.trim();
	const envEvents = process.env.DBG_EVENTS_DB?.trim();
	return {
		socketPath: envSocket || DEFAULT_SOCKET_PATH,
		eventsDbPath: envEvents || DEFAULT_EVENTS_DB_PATH,
		explicitSocket: Boolean(envSocket),
		explicitEventsDb: Boolean(envEvents),
		usingFallback: false,
	};
}

function canUseAutomaticFallback(paths: DaemonPaths): boolean {
	return (
		!paths.explicitSocket && !paths.explicitEventsDb && !paths.usingFallback
	);
}

function buildFallbackDaemonPaths(paths: DaemonPaths): DaemonPaths {
	const uid =
		typeof process.getuid === "function" ? String(process.getuid()) : "0";
	const repoHash = createHash("sha1")
		.update(process.cwd())
		.digest("hex")
		.slice(0, 10);
	return {
		socketPath: `/tmp/dbg-${uid}-${repoHash}.sock`,
		eventsDbPath: `/tmp/dbg-${uid}-${repoHash}-events.db`,
		explicitSocket: paths.explicitSocket,
		explicitEventsDb: paths.explicitEventsDb,
		usingFallback: true,
	};
}

function daemonEnv(paths: DaemonPaths): NodeJS.ProcessEnv {
	return {
		...process.env,
		DBG_SOCK: paths.socketPath,
		DBG_EVENTS_DB: paths.eventsDbPath,
	};
}

function isDaemonRunning(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		if (!fs.existsSync(socketPath)) {
			resolve(false);
			return;
		}
		const socket = net.createConnection(socketPath);
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			resolve(false);
		});
		socket.setTimeout(1000, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function ensureDaemon(paths: DaemonPaths): Promise<void> {
	if (await isDaemonRunning(paths.socketPath)) return;

	// NOTE: the client deliberately never unlinks the socket file. Concurrent
	// CLI invocations race this spawn path, and deleting the file here could
	// erase a socket a daemon just bound. Stale-socket recovery is the
	// daemon's job (bind-or-defer with a health probe in startServer); a
	// daemon forked against a live socket simply defers and exits.

	const thisFile = fileURLToPath(import.meta.url);
	const thisDir = dirname(thisFile);
	const daemonPath = join(thisDir, "daemon.js");

	// Spawn daemon fully detached — no pipes, no IPC
	const child = fork(daemonPath, [], {
		detached: true,
		stdio: "ignore",
		env: daemonEnv(paths),
	});
	child.unref();
	child.disconnect?.();

	// Poll for socket to appear (daemon creates it on startup)
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		if (await isDaemonRunning(paths.socketPath)) return;
	}
	throw new Error(
		`daemon failed to start (socket not created at ${paths.socketPath})`,
	);
}

export async function ensureDaemonWithFallback(
	paths: DaemonPaths,
): Promise<DaemonPaths> {
	try {
		await ensureDaemon(paths);
		return paths;
	} catch (primaryError) {
		if (!canUseAutomaticFallback(paths)) {
			throw primaryError;
		}

		const fallback = buildFallbackDaemonPaths(paths);
		try {
			await ensureDaemon(fallback);
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				[
					String((primaryError as Error).message),
					`fallback daemon at ${fallback.socketPath} also failed: ${(fallbackError as Error).message}`,
				].join("; "),
			);
		}
	}
}

function sendRaw(
	cmd: Command,
	timeoutMs: number,
	socketPath: string,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(cmd)}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newlineIdx = buffer.indexOf("\n");
			if (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				try {
					const response = JSON.parse(line) as Response;
					socket.destroy();
					resolve(response);
				} catch {
					socket.destroy();
					reject(new Error("invalid response from daemon"));
				}
			}
		});

		socket.on("error", (err) => {
			reject(
				new Error(`cannot connect to daemon at ${socketPath}: ${err.message}`),
			);
		});

		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			reject(
				new Error(
					`timeout waiting for daemon response (${Math.ceil(timeoutMs / 1000)}s)`,
				),
			);
		});
	});
}

async function sendCommandWithFallback(
	cmd: Command,
	timeoutMs: number,
	paths: DaemonPaths,
): Promise<{ response: Response; paths: DaemonPaths }> {
	try {
		const response = await sendRaw(cmd, timeoutMs, paths.socketPath);
		return { response, paths };
	} catch (primaryError) {
		if (!canUseAutomaticFallback(paths)) {
			throw primaryError;
		}

		const fallback = buildFallbackDaemonPaths(paths);
		try {
			await ensureDaemon(fallback);
			const response = await sendRaw(cmd, timeoutMs, fallback.socketPath);
			return { response, paths: fallback };
		} catch (fallbackError) {
			throw new Error(
				[
					String((primaryError as Error).message),
					`fallback daemon at ${fallback.socketPath} also failed: ${(fallbackError as Error).message}`,
				].join("; "),
			);
		}
	}
}

export function computeCommandTimeoutMs(cmd: Command): number {
	const DEFAULT_TIMEOUT_MS = 60000;

	if (cmd.cmd === "attach") {
		const DEFAULT_ATTACH_TIMEOUT_MS = 45000;
		const base =
			typeof cmd.attachTimeoutMs === "number" &&
			Number.isFinite(cmd.attachTimeoutMs) &&
			cmd.attachTimeoutMs > 0
				? Math.round(cmd.attachTimeoutMs)
				: DEFAULT_ATTACH_TIMEOUT_MS;
		const strategy = cmd.attachStrategy ?? "auto";
		const strategyAttempts = strategy === "auto" ? 2 : 1;
		// Extra multiplier accounts for auto-retry with --launch in daemon
		const retryMultiplier = 2;
		return Math.max(
			DEFAULT_TIMEOUT_MS,
			base * strategyAttempts * retryMultiplier + 30000,
		);
	}

	return DEFAULT_TIMEOUT_MS;
}

/**
 * Send a typed Command to the daemon, auto-spawning it if necessary.
 *
 * Returns the parsed Response on success. Throws on I/O errors or if the
 * daemon responds with a non-ok Response (callers that want to surface
 * daemon-side error messages directly should catch and inspect `.message`).
 *
 * The `close` command is special-cased to be idempotent: if the socket
 * doesn't exist (or the fallback doesn't exist either), this returns a
 * synthetic ok Response instead of starting a daemon just to shut it down.
 */
export async function sendCommand(cmd: Command): Promise<Response> {
	let paths = resolveInitialDaemonPaths();

	if (cmd.cmd === "close") {
		// Idempotent close: don't auto-spawn just to tell the daemon to quit.
		if (!fs.existsSync(paths.socketPath) && canUseAutomaticFallback(paths)) {
			const fallback = buildFallbackDaemonPaths(paths);
			if (fs.existsSync(fallback.socketPath)) {
				paths = fallback;
			}
		}
		if (!fs.existsSync(paths.socketPath)) {
			return { ok: true, messages: [] };
		}
		try {
			return await sendRaw(cmd, computeCommandTimeoutMs(cmd), paths.socketPath);
		} catch {
			// Socket is stale — treat close as a no-op.
			try {
				fs.unlinkSync(paths.socketPath);
			} catch {
				// ignore
			}
			return { ok: true, messages: [] };
		}
	}

	paths = await ensureDaemonWithFallback(paths);
	const { response } = await sendCommandWithFallback(
		cmd,
		computeCommandTimeoutMs(cmd),
		paths,
	);

	if (!response.ok) {
		const err = new Error(response.error) as Error & {
			errorCode?: string;
			response: typeof response;
		};
		err.errorCode = response.errorCode;
		err.response = response;
		throw err;
	}

	return response;
}
