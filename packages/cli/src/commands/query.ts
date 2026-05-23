// SQL query: q <sql>.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function registerQueryCommand(cli: Cli.Cli): void {
	cli.command("q", {
		description: "Run a SQL query against the table registry",
		args: z.object({
			sql: z.string().describe("SQL-like query (e.g. 'SELECT * FROM frames')"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = { cmd: "q", sql: args.sql };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
