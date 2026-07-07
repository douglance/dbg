// Thin CLI entry: wires typed subcommands into an incur-powered CLI.
//
// Each sub-module registers a slice of commands that build a typed
// `Command` payload and dispatch it to the background daemon via
// `daemon-client.sendCommand`. Output rendering (TOON/JSON/YAML/Markdown)
// and the `--json`, `--format`, `--help`, `--llms`, `--verbose` flags are
// handled by incur.

import { Cli } from "incur";
import { registerBreakpointCommands } from "./commands/breakpoints.js";
import { registerBrowserCommands } from "./commands/browser.js";
import { registerDiagCommands } from "./commands/diag.js";
import { registerFlowCommands } from "./commands/flow.js";
import { registerInspectCommands } from "./commands/inspect.js";
import { registerLifecycleCommands } from "./commands/lifecycle.js";
import { registerNativeCommands } from "./commands/native.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerRecordCommands } from "./commands/record.js";

const cli = Cli.create("dbg", {
	description:
		"Stateless CLI debugger for AI agents. One command in, one response out; a background daemon holds CDP/DAP connections between calls.",
	version: "0.3.0",
});

registerLifecycleCommands(cli);
registerFlowCommands(cli);
registerBreakpointCommands(cli);
registerInspectCommands(cli);
registerDiagCommands(cli);
registerQueryCommand(cli);
registerBrowserCommands(cli);
registerRecordCommands(cli);
registerNativeCommands(cli);

cli.serve();
