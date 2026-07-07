import type { QueryRegistry } from "@dbg/query";

import { agentPromptsTable } from "./agent-prompts.js";
import {
	agentSessionsTable,
	resetSessionCache,
	sessionScanStats,
} from "./agent-sessions.js";
import { commitsTable } from "./commits.js";

export {
	agentPromptsTable,
	agentSessionsTable,
	commitsTable,
	resetSessionCache,
	sessionScanStats,
};

export function registerDevTables(registry: QueryRegistry): void {
	registry.register(commitsTable);
	registry.register(agentPromptsTable);
	registry.register(agentSessionsTable);
}
