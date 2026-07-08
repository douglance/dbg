// Inspection: e (evaluate), src (view source).

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerInspectCommands(cli: Cli.Cli): void {
	cli.command("e", {
		description: "Evaluate an expression in the current frame",
		args: z.object({
			expression: z.string().describe("JavaScript expression"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = { cmd: "e", expression: args.expression };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("src", {
		description: "View source (current paused location by default)",
		args: z.object({
			file: z.string().optional().describe("Source file path"),
			start: z.coerce.number().int().optional().describe("Start line"),
			end: z.coerce.number().int().optional().describe("End line"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const hasFile = args.file !== undefined;
			const hasStart = args.start !== undefined;
			const hasEnd = args.end !== undefined;
			if (hasFile !== hasStart || hasFile !== hasEnd) {
				throw new Error(
					"src requires either no args (current frame) or all of <file> <start> <end>",
				);
			}
			const cmd: Command = hasFile
				? {
						cmd: "src",
						file: args.file,
						start: args.start,
						end: args.end,
					}
				: { cmd: "src" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
