// Lifecycle + session-management commands: open, close, run, restart,
// status, attach, attach-lldb, devices, apps, ss, use, targets.

import { type Cli, z } from "incur";
import type {
	AttachPlatform,
	AttachProvider,
	AttachStrategy,
	Command,
} from "@dbg/types";
import { sendCommand } from "../daemon-client.js";

const PLATFORMS = [
	"auto",
	"ios",
	"tvos",
	"watchos",
	"visionos",
] as const satisfies readonly AttachPlatform[];
const PROVIDERS = ["apple-device"] as const satisfies readonly AttachProvider[];
const STRATEGIES = [
	"auto",
	"device-process",
	"gdb-remote",
] as const satisfies readonly AttachStrategy[];

function parsePortArg(raw: string): { port: number; host?: string } {
	if (raw.includes(":")) {
		const [host, portStr] = raw.split(":");
		const port = Number.parseInt(portStr, 10);
		if (Number.isNaN(port)) throw new Error(`invalid port: ${raw}`);
		return { port, host };
	}
	const port = Number.parseInt(raw, 10);
	if (Number.isNaN(port)) throw new Error(`invalid port: ${raw}`);
	return { port };
}

export function registerLifecycleCommands(cli: Cli.Cli): void {
	cli.command("open", {
		description: "Connect to a running debug target by port",
		args: z.object({
			port: z
				.string()
				.describe("Port or host:port (e.g. 9229 or 192.168.1.5:9229)"),
			name: z.string().optional().describe("Optional session name"),
		}),
		options: z.object({
			type: z
				.enum(["page", "node"])
				.optional()
				.describe("Target kind for browser vs Node"),
			target: z.string().optional().describe("Specific target id"),
			session: z
				.string()
				.optional()
				.describe("Session name (overrides positional name)"),
		}),
		async run({ args, options }) {
			const { port, host } = parsePortArg(args.port);
			const cmd: Command = { cmd: "open", port };
			if (host) cmd.host = host;
			if (options.type) cmd.type = options.type;
			if (options.target) cmd.target = options.target;
			const sessionName = options.session ?? args.name;
			if (sessionName) cmd.session = sessionName;
			return await sendCommand(cmd);
		},
	});

	cli.command("close", {
		description: "Disconnect the session (and kill any managed child process)",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "close" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("run", {
		description: "Spawn a Node process with --inspect-brk and attach",
		args: z.object({
			command: z.string().describe("Command line to execute"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = { cmd: "run", command: args.command };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("restart", {
		description:
			"Kill managed target, respawn, reconnect, re-apply breakpoints",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "restart" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("status", {
		description: "Connection/pause state snapshot for the session",
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ options }) {
			const cmd: Command = { cmd: "status" };
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("attach", {
		description:
			"Attach to an app on an Apple device/simulator via a provider (DAP)",
		args: z.object({
			bundleId: z
				.string()
				.describe("App bundle identifier (e.g. com.workstation.app)"),
		}),
		options: z.object({
			provider: z
				.enum(PROVIDERS)
				.default("apple-device")
				.describe("Attach provider"),
			platform: z.enum(PLATFORMS).default("auto").describe("Target platform"),
			device: z
				.string()
				.optional()
				.describe("Device id, sim:name, or device:udid"),
			pid: z.coerce.number().int().positive().optional().describe("Target PID"),
			launch: z
				.boolean()
				.optional()
				.describe("Launch the app before attaching"),
			attachStrategy: z
				.enum(STRATEGIES)
				.optional()
				.describe("Attach strategy fallback"),
			attachTimeout: z.coerce
				.number()
				.positive()
				.optional()
				.describe("Attach timeout in seconds"),
			verboseAttach: z
				.boolean()
				.optional()
				.describe("Emit verbose attach diagnostics"),
			session: z.string().optional().describe("Target session by name"),
		}),
		alias: { verboseAttach: "v" },
		async run({ args, options }) {
			const cmd: Command = {
				cmd: "attach",
				provider: options.provider,
				platform: options.platform,
				bundleId: args.bundleId,
			};
			if (options.device !== undefined) cmd.device = options.device;
			if (options.pid !== undefined) cmd.pid = options.pid;
			if (options.launch !== undefined) cmd.launch = options.launch;
			if (options.attachStrategy !== undefined)
				cmd.attachStrategy = options.attachStrategy;
			if (options.attachTimeout !== undefined)
				cmd.attachTimeoutMs = Math.round(options.attachTimeout * 1000);
			if (options.verboseAttach !== undefined)
				cmd.verbose = options.verboseAttach;
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("attach-lldb", {
		description: "Launch lldb-dap against a local native binary",
		args: z.object({
			program: z.string().describe("Path to the native binary"),
			args: z.array(z.string()).optional().describe("Program arguments"),
		}),
		options: z.object({
			session: z.string().optional().describe("Target session by name"),
		}),
		async run({ args, options }) {
			const cmd: Command = { cmd: "attach-lldb", program: args.program };
			if (args.args && args.args.length > 0) cmd.args = args.args;
			if (options.session) cmd.session = options.session;
			return await sendCommand(cmd);
		},
	});

	cli.command("devices", {
		description: "List Apple devices + simulators",
		options: z.object({
			platform: z.enum(PLATFORMS).optional().describe("Filter by platform"),
		}),
		async run({ options }) {
			const cmd: Command = options.platform
				? { cmd: "devices", platform: options.platform }
				: { cmd: "devices" };
			return await sendCommand(cmd);
		},
	});

	cli.command("apps", {
		description: "List installed apps on an Apple device or simulator",
		args: z.object({
			deviceId: z.string().describe("Device id (udid or sim:name)"),
		}),
		async run({ args }) {
			return await sendCommand({ cmd: "apps", deviceId: args.deviceId });
		},
	});

	cli.command("ss", {
		description: "List all active sessions",
		async run() {
			return await sendCommand({ cmd: "ss" });
		},
	});

	cli.command("use", {
		description: "Switch the current session pointer",
		args: z.object({
			name: z.string().describe("Session name"),
		}),
		async run({ args }) {
			return await sendCommand({ cmd: "use", name: args.name });
		},
	});

	cli.command("targets", {
		description: "List debuggable targets at a port",
		args: z.object({
			port: z.string().describe("Port or host:port"),
		}),
		async run({ args }) {
			const { port, host } = parsePortArg(args.port);
			const cmd: Command = host
				? { cmd: "targets", port, host }
				: { cmd: "targets", port };
			return await sendCommand(cmd);
		},
	});
}
