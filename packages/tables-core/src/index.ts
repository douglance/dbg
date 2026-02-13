import type { QueryRegistry } from "@dbg/query";

import { asyncFramesTable } from "./async_frames.js";
import { breakpointsTable } from "./breakpoints.js";
import { cdpMessagesTable, cdpTable } from "./cdp_messages.js";
import { connectionsTable } from "./connections.js";
import { consoleTable } from "./console.js";
import { eventsTable } from "./events.js";
import { exceptionsTable } from "./exceptions.js";
import { framesTable } from "./frames.js";
import { listenersTable } from "./listeners.js";
import { propsTable } from "./props.js";
import { protoTable } from "./proto.js";
import { scopesTable } from "./scopes.js";
import { scriptsTable } from "./scripts.js";
import { sourceTable } from "./source.js";
import { thisTable } from "./this.js";
import { timelineTable } from "./timeline.js";
import { varsTable } from "./vars.js";

export {
	asyncFramesTable,
	breakpointsTable,
	cdpMessagesTable,
	cdpTable,
	connectionsTable,
	consoleTable,
	eventsTable,
	exceptionsTable,
	framesTable,
	listenersTable,
	propsTable,
	protoTable,
	scopesTable,
	scriptsTable,
	sourceTable,
	thisTable,
	timelineTable,
	varsTable,
};

export function registerCoreTables(registry: QueryRegistry): void {
	registry.register(framesTable);
	registry.register(scopesTable);
	registry.register(varsTable);
	registry.register(thisTable);
	registry.register(propsTable);
	registry.register(protoTable);
	registry.register(breakpointsTable);
	registry.register(scriptsTable);
	registry.register(sourceTable);
	registry.register(consoleTable);
	registry.register(exceptionsTable);
	registry.register(asyncFramesTable);
	registry.register(listenersTable);
	registry.register(eventsTable);
	registry.register(cdpTable);
	registry.register(cdpMessagesTable);
	registry.register(connectionsTable);
	registry.register(timelineTable);
}
