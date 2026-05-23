// Diagnostics: trace, health, reconnect.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerDiagCommands(cli: Cli.Cli): void {
	cli.command("trace", {
		description: "Show recent protocol send/recv history",
		args: z.object({
			limit: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe("Max entries"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command =
				args.limit !== undefined
					? { cmd: "trace", limit: args.limit }
					: { cmd: "trace" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("health", {
		description: "Probe Runtime.evaluate('1+1') and report latency",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "health" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("reconnect", {
		description: "Reconnect to the last known websocket URL",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "reconnect" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
