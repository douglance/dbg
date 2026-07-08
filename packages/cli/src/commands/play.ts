// Playwright runner bridge: expose @douglance/play through dbg.

import { resolveInput, runScript } from "@douglance/play";
import { type Cli, z } from "incur";

export function registerPlayCommand(cli: Cli.Cli): void {
	cli.command("play", {
		description:
			"Run a Playwright script via @douglance/play (inline code, file path, or stdin)",
		args: z.object({
			input: z
				.string()
				.optional()
				.describe("Inline code or path to a .ts/.js play script"),
		}),
		options: z.object({
			headed: z.boolean().optional().describe("Show browser window"),
			slow: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe("Slow motion delay in ms"),
			port: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe("Dev server port"),
			url: z.string().optional().describe("URL to navigate to"),
			timeout: z.coerce
				.number()
				.int()
				.positive()
				.optional()
				.describe("Playwright action timeout in ms"),
			browser: z
				.enum(["chromium", "firefox", "webkit"])
				.optional()
				.describe("Browser engine"),
			device: z.string().optional().describe("Playwright device preset"),
			devtools: z.boolean().optional().describe("Auto-open Chromium DevTools"),
		}),
		async run({ args, options }) {
			const input = await resolveInput(args.input);
			const result = await runScript(input.code, {
				...options,
				sourceName: input.sourceName,
			});
			const ok =
				!result.error && result.assertions.every((assertion) => assertion.pass);
			if (!ok) process.exitCode = 1;
			return {
				ok,
				...result,
			};
		},
	});
}
