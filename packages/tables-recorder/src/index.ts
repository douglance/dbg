import type { QueryRegistry } from "@dbg/query";

import { capturesTable } from "./captures.js";
import { epochsTable } from "./epochs.js";

export { capturesTable, epochsTable };

export function registerRecorderTables(registry: QueryRegistry): void {
	registry.register(capturesTable);
	registry.register(epochsTable);
}
