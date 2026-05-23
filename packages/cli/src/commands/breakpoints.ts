// Breakpoint commands: b (set), db (delete), bl (list).

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerBreakpointCommands(cli: Cli.Cli): void {
	cli.command("b", {
		description: "Set a breakpoint at file:line (optionally conditional)",
		args: z.object({
			location: z
				.string()
				.describe("Source location in file:line form (e.g. app.ts:42)"),
		}),
		options: z.object({
			if: z.string().optional().describe("Conditional breakpoint expression"),
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const colonIdx = args.location.lastIndexOf(":");
			if (colonIdx === -1) {
				throw new Error("expected file:line (e.g. app.ts:42)");
			}
			const file = args.location.slice(0, colonIdx);
			const line = Number.parseInt(args.location.slice(colonIdx + 1), 10);
			if (Number.isNaN(line)) {
				throw new Error("invalid line number");
			}
			const cmd: Command = { cmd: "b", file, line };
			if (options.if !== undefined) cmd.condition = options.if;
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("db", {
		description: "Delete a breakpoint by id",
		args: z.object({
			id: z.string().describe("Breakpoint id returned by `b` or `bl`"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = { cmd: "db", id: args.id };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("bl", {
		description: "List all breakpoints",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "bl" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
