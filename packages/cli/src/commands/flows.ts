// Recorded user flows: record/stop/run/list/show.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerFlowsCommands(cli: Cli.Cli): void {
	cli.command("flow", {
		description:
			"Recorded flows: record <name> [--url] | stop | run <name> [--step-timeout] | list | show <name>",
		args: z.object({
			action: z.string().describe("record | stop | run | list | show"),
			name: z.string().optional().describe("Flow name"),
		}),
		options: z.object({
			url: z.string().optional().describe("Start URL for record"),
			stepTimeout: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe("Per-step readiness timeout in ms (run; default 5000)"),
		}),
		async run({ args, options }) {
			switch (args.action) {
				case "record": {
					if (!args.name) throw new Error("usage: dbg flow record <name>");
					const cmd: Command = { cmd: "flow.record", name: args.name };
					if (options.url) cmd.url = options.url;
					return await sendCommand(cmd);
				}
				case "stop":
					return await sendCommand({ cmd: "flow.stop" });
				case "run": {
					if (!args.name) throw new Error("usage: dbg flow run <name>");
					const cmd: Command = { cmd: "flow.run", name: args.name };
					if (options.stepTimeout !== undefined) {
						cmd.stepTimeoutMs = options.stepTimeout;
					}
					return await sendCommand(cmd);
				}
				case "list":
					return await sendCommand({ cmd: "flow.list" });
				case "show": {
					if (!args.name) throw new Error("usage: dbg flow show <name>");
					return await sendCommand({ cmd: "flow.show", name: args.name });
				}
				default:
					throw new Error(
						`unknown flow action: ${args.action} (record|stop|run|list|show)`,
					);
			}
		},
	});
}
