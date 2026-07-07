// Visual flight recorder command: record (start), --stop, --status.

import { type Cli, z } from "incur";
import type { Command } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

export function parseViewport(raw: string): { width: number; height: number } {
	const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
	if (!match) {
		throw new Error(`invalid viewport "${raw}" (expected WxH, e.g. 1280x720)`);
	}
	const width = Number.parseInt(match[1], 10);
	const height = Number.parseInt(match[2], 10);
	if (width <= 0 || height <= 0) {
		throw new Error(`invalid viewport "${raw}" (dimensions must be positive)`);
	}
	return { width, height };
}

export function registerRecordCommands(cli: Cli.Cli): void {
	cli.command("record", {
		description:
			"Record the page visually: daemon launches managed headless Chrome, attaches, and captures frames",
		args: z.object({
			url: z
				.string()
				.optional()
				.describe("URL to record (e.g. http://localhost:3000)"),
		}),
		options: z.object({
			stop: z
				.boolean()
				.optional()
				.describe("Stop the recording and kill managed Chrome"),
			status: z.boolean().optional().describe("Show recording status"),
			viewport: z
				.string()
				.optional()
				.describe("Viewport as WxH (e.g. 1280x720)"),
			idle: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"FS quiet period in ms that starts a new auto epoch (default 10000)",
				),
		}),
		async run({ args, options }) {
			if (options.stop) {
				return await sendCommand({ cmd: "record.stop" });
			}
			if (options.status) {
				return await sendCommand({ cmd: "record.status" });
			}
			if (!args.url) {
				throw new Error("usage: record <url> (or --stop / --status)");
			}
			const cmd: Command = { cmd: "record.start", urls: [args.url] };
			if (options.viewport) {
				cmd.viewport = parseViewport(options.viewport);
			}
			if (options.idle !== undefined) {
				cmd.idleThresholdMs = options.idle;
			}
			return await sendCommand(cmd);
		},
	});

	cli.command("mark", {
		description:
			"Stamp a named epoch in the recording timeline (auto-epochs from edit bursts exist regardless)",
		args: z.object({
			name: z.string().optional().describe("Epoch name (e.g. checkpoint)"),
		}),
		async run({ args }) {
			const cmd: Command = { cmd: "record.mark" };
			if (args.name) {
				cmd.name = args.name;
			}
			return await sendCommand(cmd);
		},
	});
}
