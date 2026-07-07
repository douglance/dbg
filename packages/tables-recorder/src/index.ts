import type { QueryRegistry } from "@dbg/query";

import { capturesTable } from "./captures.js";
import { diffsTable } from "./diffs.js";
import { epochsTable } from "./epochs.js";

export { capturesTable, diffsTable, epochsTable };

export function registerRecorderTables(registry: QueryRegistry): void {
	registry.register(capturesTable);
	registry.register(epochsTable);
	registry.register(diffsTable);
}
