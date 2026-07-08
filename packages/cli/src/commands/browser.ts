// Browser automation commands: navigate, screenshot, click, type, select,
// mock, unmock, emulate, throttle, coverage.

import { type Cli, z } from "incur";
import type { Command, NavigateAction } from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

const sessionOnly = z.object({
	session: z.string().optional().describe("Target session by name"),
});

export function registerBrowserCommands(cli: Cli.Cli): void {
	cli.command("navigate", {
		description: "Navigate the browser page (url|reload|back|forward)",
		args: z.object({
			target: z.string().describe("URL, or one of: reload, back, forward"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const raw = args.target;
			let action: NavigateAction;
			if (raw === "reload" || raw === "back" || raw === "forward") {
				action = { action: raw };
			} else {
				action = { action: "url", url: raw };
			}
			const cmd: Command = { cmd: "navigate", action };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("screenshot", {
		description: "Capture a PNG screenshot",
		args: z.object({
			path: z
				.string()
				.optional()
				.describe("File path to save to (omit to return base64)"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = args.path
				? { cmd: "screenshot", path: args.path }
				: { cmd: "screenshot" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("click", {
		description: "Click an element by CSS selector",
		args: z.object({
			selector: z.string().describe("CSS selector"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = { cmd: "click", selector: args.selector };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("type", {
		description: "Type text into an element",
		args: z.object({
			selector: z.string().describe("CSS selector"),
			text: z.string().describe("Text to type"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = {
				cmd: "type",
				selector: args.selector,
				text: args.text,
			};
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("select", {
		description: "Select a <select> option by value",
		args: z.object({
			selector: z.string().describe("CSS selector"),
			value: z.string().describe("Option value"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = {
				cmd: "select",
				selector: args.selector,
				value: args.value,
			};
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("mock", {
		description: "Mock a network response",
		args: z.object({
			urlPattern: z.string().describe("URL substring/pattern to intercept"),
			body: z.string().describe("Response body (JSON recommended)"),
		}),
		options: z.object({
			status: z.coerce.number().int().optional().describe("HTTP status code"),
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = {
				cmd: "mock",
				urlPattern: args.urlPattern,
				body: args.body,
			};
			if (options.status !== undefined) cmd.status = options.status;
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("unmock", {
		description: "Remove mock(s). Omit pattern to clear all.",
		args: z.object({
			pattern: z.string().optional().describe("Pattern to remove"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = args.pattern
				? { cmd: "unmock", pattern: args.pattern }
				: { cmd: "unmock" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("emulate", {
		description: "Emulate a mobile device preset (or 'reset')",
		args: z.object({
			preset: z.string().describe("Preset name (e.g. iphone-14, ipad, reset)"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = { cmd: "emulate", preset: args.preset };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("throttle", {
		description: "Apply a network throttling preset (or 'off')",
		args: z.object({
			preset: z
				.string()
				.describe("Preset (e.g. 3g, slow-3g, fast-3g, 4g, offline, off)"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = { cmd: "throttle", preset: args.preset };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("coverage", {
		description: "Start or stop code coverage tracking",
		args: z.object({
			action: z.enum(["start", "stop"]).describe("start | stop"),
		}),
		options: sessionOnly,
		async run({ args, options }) {
			const cmd: Command = { cmd: "coverage", action: args.action };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});
}
