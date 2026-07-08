// Native debug (LLDB/DAP) commands: registers, memory, disasm.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerNativeCommands(cli: Cli.Cli): void {
	cli.command("registers", {
		description: "Show CPU register values (LLDB sessions)",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "registers" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("memory", {
		description: "Read process memory",
		args: z.object({
			address: z.string().describe("Address (hex or decimal)"),
			length: z.coerce.number().int().positive().describe("Number of bytes"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = {
				cmd: "memory",
				address: args.address,
				length: args.length,
			};
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("disasm", {
		description: "Disassemble around an address (current frame by default)",
		args: z.object({
			address: z.string().optional().describe("Address (hex or decimal)"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = args.address
				? { cmd: "disasm", address: args.address }
				: { cmd: "disasm" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
