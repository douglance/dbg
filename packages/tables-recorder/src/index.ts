import type { QueryRegistry } from "@dbg/query";

import { capturesTable } from "./captures.js";
import { diffsTable } from "./diffs.js";
import { editsTable } from "./edits.js";
import { epochsTable } from "./epochs.js";
import { regionsTable } from "./regions.js";

export { capturesTable, diffsTable, editsTable, epochsTable, regionsTable };

export function registerRecorderTables(registry: QueryRegistry): void {
	registry.register(capturesTable);
	registry.register(epochsTable);
	registry.register(diffsTable);
	registry.register(regionsTable);
	registry.register(editsTable);
}
