import type { QueryRegistry } from "@dbg/query";

import { a11yIssuesTable } from "./a11y-issues.js";
import { capturesTable } from "./captures.js";
import { diffsTable } from "./diffs.js";
import { editsTable } from "./edits.js";
import { epochsTable } from "./epochs.js";
import {
	flowRunStepsTable,
	flowRunsTable,
	flowStepsTable,
	flowsTable,
} from "./flows.js";
import { perfSamplesTable } from "./perf-samples.js";
import { regionsTable } from "./regions.js";
import { stateSnapshotsTable } from "./state-snapshots.js";
import { tapHitsTable, tapsTable } from "./taps.js";

export {
	a11yIssuesTable,
	capturesTable,
	diffsTable,
	editsTable,
	epochsTable,
	flowRunStepsTable,
	flowRunsTable,
	flowStepsTable,
	flowsTable,
	perfSamplesTable,
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
	registry.register(perfSamplesTable);
	registry.register(tapsTable);
	registry.register(tapHitsTable);
	registry.register(flowsTable);
	registry.register(flowStepsTable);
	registry.register(flowRunsTable);
	registry.register(flowRunStepsTable);
}
