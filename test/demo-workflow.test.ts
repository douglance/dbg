import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CLI = path.resolve(__dirname, "../dist/cli.js");
const SOCKET_PATH = "/tmp/dbg.sock";
const HANDLER = path.resolve(__dirname, "fixtures/handler.js");
const EVENTS_DB_PATH = path.resolve(__dirname, ".tmp-demo-events.db");

function dbg(...args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, DBG_EVENTS_DB: EVENTS_DB_PATH },
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: err.status ?? 1,
		};
	}
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function killDaemon(): void {
	try {
		if (fs.existsSync(SOCKET_PATH)) {
			try {
				execFileSync(process.execPath, [CLI, "close"], {
					encoding: "utf8",
					timeout: 5000,
					env: { ...process.env, DBG_EVENTS_DB: EVENTS_DB_PATH },
				});
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
	try {
		const pids = execFileSync("lsof", ["-t", SOCKET_PATH], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		for (const pid of pids.split("\n").filter(Boolean)) {
			try {
				process.kill(Number.parseInt(pid, 10), "SIGTERM");
			} catch {
				/* dead */
			}
		}
	} catch {
		/* no process */
	}
	try {
		fs.unlinkSync(SOCKET_PATH);
	} catch {
		/* ignore */
	}
}

describe("demo workflow — matches launch video outputs", () => {
	let targetProcess: ChildProcess | null = null;

	beforeAll(() => killDaemon());

	afterEach(async () => {
		try {
			dbg("close");
		} catch {
			/* ignore */
		}
		if (targetProcess && !targetProcess.killed) {
			targetProcess.kill("SIGKILL");
			targetProcess = null;
		}
		killDaemon();
		await sleep(200);
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				fs.unlinkSync(EVENTS_DB_PATH + suffix);
			} catch {
				/* ignore */
			}
		}
	});

	afterAll(() => killDaemon());

	async function spawnHandler(): Promise<number> {
		const port = await findFreePort();
		targetProcess = spawn(
			process.execPath,
			[`--inspect-brk=${port}`, HANDLER],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		return new Promise((resolve, reject) => {
			let stderr = "";
			const timeout = setTimeout(
				() => reject(new Error("handler did not start")),
				10000,
			);
			if (!targetProcess?.stderr) {
				clearTimeout(timeout);
				reject(new Error("no stderr"));
				return;
			}
			targetProcess.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				const match = stderr.match(
					/Debugger listening on ws:\/\/[\w.]+:(\d+)\//,
				);
				if (match) {
					clearTimeout(timeout);
					resolve(Number.parseInt(match[1], 10));
				}
			});
			targetProcess.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	it("reproduces the exact crab agent workflow from the launch video", async () => {
		const port = await spawnHandler();
		const openResult = dbg("open", String(port));
		expect(openResult.exitCode).toBe(0);
		expect(openResult.stdout).toContain("connected");

		// Wait for debugger pause event to propagate
		await sleep(200);

		// Step to line 13 where all vars are in scope
		dbg("n"); // → line 9
		dbg("n"); // → line 10
		dbg("n"); // → line 11
		dbg("n"); // → line 13

		// 1. dbg status → connected, paused at handler.js:13
		const status = dbg("status");
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain("connected");
		expect(status.stdout).toContain("paused");
		expect(status.stdout).toContain("handler.js");
		expect(status.stdout).toContain("13");

		// 2. dbg q "SELECT name, type, value FROM vars" → sees req, err (null), user
		const vars = dbg("q", "SELECT name, type, value FROM vars");
		expect(vars.exitCode).toBe(0);
		expect(vars.stdout).toContain("name\ttype\tvalue");
		expect(vars.stdout).toContain("req\tobject\t[Object]");
		expect(vars.stdout).toContain("err\tnull\tnull");
		expect(vars.stdout).toContain("user\tstring\talice");

		// 3. Get req object_id and drill into props
		const varsWithId = dbg(
			"q",
			"SELECT name, object_id FROM vars WHERE name = 'req'",
		);
		const objectId = varsWithId.stdout.trim().split("\n")[1]?.split("\t")[1];
		expect(objectId).toBeTruthy();

		const props = dbg(
			"q",
			`SELECT name, type, value FROM props WHERE object_id = '${objectId}'`,
		);
		expect(props.exitCode).toBe(0);
		expect(props.stdout).toContain("url\tstring\t/api/data");
		expect(props.stdout).toContain("method\tstring\tPOST");

		// 4. dbg e "err === null" → true
		const evalResult = dbg("e", "err === null");
		expect(evalResult.exitCode).toBe(0);
		expect(evalResult.stdout.trim()).toBe("true");
	});
});
