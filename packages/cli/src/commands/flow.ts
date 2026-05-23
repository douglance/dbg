// Flow control: c (continue), s (step into), n (step over), o (step out), pause.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

const flowOptions = z.object({
	session: z.string().optional().describe("Target session by name"),
});

export function registerFlowCommands(cli: Cli.Cli): void {
	cli.command("c", {
		description: "Continue execution",
		options: flowOptions,
		async run({ options }) {
			const cmd: Command = { cmd: "c" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("s", {
		description: "Step into",
		options: flowOptions,
		async run({ options }) {
			const cmd: Command = { cmd: "s" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("n", {
		description: "Step over",
		options: flowOptions,
		async run({ options }) {
			const cmd: Command = { cmd: "n" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("o", {
		description: "Step out",
		options: flowOptions,
		async run({ options }) {
			const cmd: Command = { cmd: "o" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("pause", {
		description: "Pause execution",
		options: flowOptions,
		async run({ options }) {
			const cmd: Command = { cmd: "pause" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
