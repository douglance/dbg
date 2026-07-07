import type { QueryRegistry } from "@dbg/query";

import { agentPromptsTable } from "./agent-prompts.js";
import {
	agentSessionsTable,
	resetSessionCache,
	sessionScanStats,
} from "./agent-sessions.js";
import { commitsTable } from "./commits.js";
import { setScopeCwd } from "./internal.js";
import { timelineTable } from "./timeline.js";

export {
	agentPromptsTable,
	agentSessionsTable,
	commitsTable,
	resetSessionCache,
	sessionScanStats,
	setScopeCwd,
	timelineTable,
};

export function registerDevTables(registry: QueryRegistry): void {
	registry.register(commitsTable);
	registry.register(agentPromptsTable);
	registry.register(agentSessionsTable);
}
