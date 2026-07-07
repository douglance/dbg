// Taps (logpoints): `dbg tap add <file:line> <expr> [--url]`, `tap list`,
// `tap rm <id>`, `tap hits <id> [--tail N]`.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerTapCommands(cli: Cli.Cli): void {
	cli.command("tap", {
		description:
			"Logpoints: add <file:line> <expr> [--url] | list | rm <id> | hits <id> [--tail N]",
		args: z.object({
			action: z.string().describe("add | list | rm | hits"),
			target: z
				.string()
				.optional()
				.describe("<file:line> for add; <id> for rm/hits"),
			expr: z.string().optional().describe("expression to log (add)"),
		}),
		options: z.object({
			url: z
				.string()
				.optional()
				.describe("Override the URL regex (for bundles)"),
			tail: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe("Show only the most recent N hits"),
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			switch (args.action) {
				case "add": {
					if (!args.target || !args.expr) {
						throw new Error(
							"usage: dbg tap add <file:line> <expr> [--url <pattern>]",
						);
					}
					const colon = args.target.lastIndexOf(":");
					if (colon <= 0) {
						throw new Error("location must be <file:line>");
					}
					const file = args.target.slice(0, colon);
					const line = Number.parseInt(args.target.slice(colon + 1), 10);
					if (!Number.isInteger(line)) {
						throw new Error("line must be an integer");
					}
					const cmd: Command = { cmd: "tap.add", file, line, expr: args.expr };
					if (options.url) cmd.url = options.url;
					if (options.session) cmd.session = options.session;
					return await sendCommand(cmd);
				}
				case "list":
					return await sendCommand({ cmd: "tap.list" });
				case "rm": {
					const id = Number.parseInt(args.target ?? "", 10);
					if (!Number.isInteger(id)) throw new Error("usage: dbg tap rm <id>");
					const cmd: Command = { cmd: "tap.rm", id };
					if (options.session) cmd.session = options.session;
					return await sendCommand(cmd);
				}
				case "hits": {
					const id = Number.parseInt(args.target ?? "", 10);
					if (!Number.isInteger(id)) {
						throw new Error("usage: dbg tap hits <id> [--tail N]");
					}
					const cmd: Command = { cmd: "tap.hits", id };
					if (options.tail !== undefined) cmd.tail = options.tail;
					return await sendCommand(cmd);
				}
				default:
					throw new Error(
						`unknown tap action: ${args.action} (add|list|rm|hits)`,
					);
			}
		},
	});
}
