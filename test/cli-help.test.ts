// Snapshot-level CLI help tests. One per command group. Each spawns
// `node packages/cli/dist/cli.js <cmd> --help` and asserts targeted
// properties (description, key flags) instead of byte-for-byte snapshots
// so incur formatting evolution does not thrash these tests.

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const CLI = path.resolve(__dirname, "../packages/cli/dist/cli.js");

function help(...args: string[]): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args, "--help"], {
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				DBG_SOCK: "/tmp/dbg-help-test.sock",
				DBG_EVENTS_DB: "/tmp/dbg-help-test.db",
			},
		});
		return { stdout, exitCode: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; status?: number };
		return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
	}
}

describe("cli help", () => {
	describe("lifecycle commands", () => {
		it("open has port arg, type, target, and session options", () => {
			const r = help("open");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg open");
			expect(r.stdout).toContain("Connect to a running debug target by port");
			expect(r.stdout).toContain("port");
			expect(r.stdout).toContain("--type");
			expect(r.stdout).toContain("--target");
			expect(r.stdout).toContain("--session");
		});

		it("close has session option", () => {
			const r = help("close");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg close");
			expect(r.stdout).toContain("Disconnect");
			expect(r.stdout).toContain("--session");
		});

		it("run accepts command arg and session option", () => {
			const r = help("run");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg run");
			expect(r.stdout).toContain("Spawn a Node process");
			expect(r.stdout).toContain("command");
			expect(r.stdout).toContain("--session");
		});

		it("restart has session option", () => {
			const r = help("restart");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg restart");
			expect(r.stdout).toContain("Kill managed target");
			expect(r.stdout).toContain("--session");
		});

		it("status has session option", () => {
			const r = help("status");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg status");
			expect(r.stdout).toContain("Connection/pause state");
			expect(r.stdout).toContain("--session");
		});

		it("attach has platform, device, bundleId", () => {
			const r = help("attach");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg attach");
			expect(r.stdout).toContain("bundleId");
			expect(r.stdout).toContain("--platform");
			expect(r.stdout).toContain("--device");
			expect(r.stdout).toContain("--session");
		});

		it("ss lists sessions (no required args)", () => {
			const r = help("ss");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg ss");
			expect(r.stdout).toContain("List all active sessions");
		});

		it("use switches session", () => {
			const r = help("use");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg use");
			expect(r.stdout).toContain("Switch");
			expect(r.stdout).toContain("name");
		});

		it("targets lists targets at a port", () => {
			const r = help("targets");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg targets");
			expect(r.stdout).toContain("port");
		});
	});

	describe("flow commands", () => {
		for (const cmd of ["c", "s", "n", "o", "pause"] as const) {
			it(`${cmd} has --session option`, () => {
				const r = help(cmd);
				expect(r.exitCode).toBe(0);
				expect(r.stdout).toContain(`dbg ${cmd}`);
				expect(r.stdout).toContain("--session");
			});
		}
	});

	describe("breakpoint commands", () => {
		it("b accepts location and --if, --session", () => {
			const r = help("b");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg b");
			expect(r.stdout).toContain("Set a breakpoint");
			expect(r.stdout).toContain("location");
			expect(r.stdout).toContain("--if");
			expect(r.stdout).toContain("--session");
		});

		it("db accepts id and --session", () => {
			const r = help("db");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg db");
			expect(r.stdout).toContain("Delete a breakpoint");
			expect(r.stdout).toContain("id");
			expect(r.stdout).toContain("--session");
		});

		it("bl lists breakpoints with --session", () => {
			const r = help("bl");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg bl");
			expect(r.stdout).toContain("List all breakpoints");
			expect(r.stdout).toContain("--session");
		});
	});

	describe("inspect commands", () => {
		it("e evaluates with --session", () => {
			const r = help("e");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg e");
			expect(r.stdout).toContain("Evaluate");
			expect(r.stdout).toContain("expression");
			expect(r.stdout).toContain("--session");
		});

		it("src shows source with --session", () => {
			const r = help("src");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg src");
			expect(r.stdout).toContain("source");
			expect(r.stdout).toContain("--session");
		});
	});

	describe("diag commands", () => {
		it("trace with --session", () => {
			const r = help("trace");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg trace");
			expect(r.stdout).toContain("protocol");
			expect(r.stdout).toContain("--session");
		});

		it("health with --session", () => {
			const r = help("health");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg health");
			expect(r.stdout).toContain("--session");
		});

		it("reconnect with --session", () => {
			const r = help("reconnect");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg reconnect");
			expect(r.stdout).toContain("--session");
		});
	});

	describe("query command", () => {
		it("q accepts sql and --session", () => {
			const r = help("q");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg q");
			expect(r.stdout).toContain("SQL");
			expect(r.stdout).toContain("sql");
			expect(r.stdout).toContain("--session");
		});
	});

	describe("browser commands", () => {
		it("navigate with --session", () => {
			const r = help("navigate");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg navigate");
			expect(r.stdout).toContain("--session");
		});

		it("screenshot with --session", () => {
			const r = help("screenshot");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg screenshot");
			expect(r.stdout).toContain("--session");
		});

		it("click with selector and --session", () => {
			const r = help("click");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg click");
			expect(r.stdout).toContain("selector");
			expect(r.stdout).toContain("--session");
		});

		it("type with selector+text and --session", () => {
			const r = help("type");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg type");
			expect(r.stdout).toContain("selector");
			expect(r.stdout).toContain("text");
			expect(r.stdout).toContain("--session");
		});

		it("mock with urlPattern, body, --status, --session", () => {
			const r = help("mock");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg mock");
			expect(r.stdout).toContain("urlPattern");
			expect(r.stdout).toContain("body");
			expect(r.stdout).toContain("--status");
			expect(r.stdout).toContain("--session");
		});

		it("coverage with action and --session", () => {
			const r = help("coverage");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg coverage");
			expect(r.stdout).toContain("action");
			expect(r.stdout).toContain("--session");
		});
	});

	describe("native commands", () => {
		it("registers with --session", () => {
			const r = help("registers");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg registers");
			expect(r.stdout).toContain("--session");
		});

		it("memory with address, length, --session", () => {
			const r = help("memory");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg memory");
			expect(r.stdout).toContain("address");
			expect(r.stdout).toContain("length");
			expect(r.stdout).toContain("--session");
		});

		it("disasm with --session", () => {
			const r = help("disasm");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg disasm");
			expect(r.stdout).toContain("--session");
		});
	});

	describe("root help", () => {
		it("lists all command groups", () => {
			const r = help();
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("dbg");
			// Sample of commands from each group
			expect(r.stdout).toContain("open");
			expect(r.stdout).toContain("c");
			expect(r.stdout).toContain("b");
			expect(r.stdout).toContain("e");
			expect(r.stdout).toContain("q");
			expect(r.stdout).toContain("navigate");
			expect(r.stdout).toContain("registers");
		});
	});
});
