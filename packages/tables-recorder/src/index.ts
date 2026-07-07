import type { QueryRegistry } from "@dbg/query";

import { a11yIssuesTable } from "./a11y-issues.js";
import { capturesTable } from "./captures.js";
import { diffsTable } from "./diffs.js";
import { editsTable } from "./edits.js";
import { epochsTable } from "./epochs.js";
import { regionsTable } from "./regions.js";
import { stateSnapshotsTable } from "./state-snapshots.js";
import { tapHitsTable, tapsTable } from "./taps.js";

export {
	a11yIssuesTable,
	capturesTable,
	diffsTable,
	editsTable,
	epochsTable,
	regionsTable,
	stateSnapshotsTable,
	tapHitsTable,
	tapsTable,
};

export function registerRecorderTables(registry: QueryRegistry): void {
	registry.register(capturesTable);
	registry.register(epochsTable);
	registry.register(diffsTable);
	registry.register(regionsTable);
	registry.register(editsTable);
	registry.register(stateSnapshotsTable);
	registry.register(a11yIssuesTable);
	registry.register(tapsTable);
	registry.register(tapHitsTable);
}
