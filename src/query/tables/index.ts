// Table registry: maps table names to virtual table definitions

import type { CdpExecutor } from "../../protocol.js";
import type { WhereExpr } from "../parser.js";
import { asyncFramesTable } from "./async_frames.js";
import { breakpointsTable } from "./breakpoints.js";
import { cdpMessagesTable, cdpTable } from "./cdp_messages.js";
import { connectionsTable } from "./connections.js";
import { consoleTable } from "./console.js";
import { cookiesTable } from "./cookies.js";
import { coverageTable } from "./coverage.js";
import { domTable } from "./dom.js";
import { eventsTable } from "./events.js";
import { exceptionsTable } from "./exceptions.js";
import { framesTable } from "./frames.js";
import { listenersTable } from "./listeners.js";
import { networkTable } from "./network.js";
import { networkBodyTable } from "./network_body.js";
import { networkHeadersTable } from "./network_headers.js";
import { pageEventsTable } from "./page_events.js";
import { performanceTable } from "./performance.js";
import { propsTable } from "./props.js";
import { protoTable } from "./proto.js";
import { scopesTable } from "./scopes.js";
import { scriptsTable } from "./scripts.js";
import { sourceTable } from "./source.js";
import { storageTable } from "./storage.js";
import { stylesTable } from "./styles.js";
import { thisTable } from "./this.js";
import { timelineTable } from "./timeline.js";
import { varsTable } from "./vars.js";
import { wsFramesTable } from "./ws_frames.js";

export interface VirtualTable {
	name: string;
	columns: string[];
	requiredFilters?: string[];
	fetch(
		where: WhereExpr | null,
		executor: CdpExecutor,
	): Promise<{ columns: string[]; rows: unknown[][] }>;
}

const tables: Map<string, VirtualTable> = new Map();

function register(table: VirtualTable): void {
	tables.set(table.name, table);
}

register(framesTable);
register(scopesTable);
register(varsTable);
register(thisTable);
register(propsTable);
register(protoTable);
register(breakpointsTable);
register(scriptsTable);
register(sourceTable);
register(consoleTable);
register(exceptionsTable);
register(asyncFramesTable);
register(listenersTable);
register(eventsTable);
register(cdpTable);
register(cdpMessagesTable);
register(connectionsTable);
register(networkTable);
register(networkHeadersTable);
register(networkBodyTable);
register(pageEventsTable);
register(domTable);
register(stylesTable);
register(performanceTable);
register(cookiesTable);
register(storageTable);
register(wsFramesTable);
register(coverageTable);
register(timelineTable);

export function getTable(name: string): VirtualTable | undefined {
	return tables.get(name);
}

export function listTables(): string[] {
	return Array.from(tables.keys());
}
