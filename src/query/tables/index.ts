// Table registry: maps table names to virtual table definitions

import type { CdpExecutor } from "../../protocol.js";
import type { WhereExpr } from "../parser.js";
import { framesTable } from "./frames.js";
import { scopesTable } from "./scopes.js";
import { varsTable } from "./vars.js";
import { thisTable } from "./this.js";
import { propsTable } from "./props.js";
import { protoTable } from "./proto.js";
import { breakpointsTable } from "./breakpoints.js";
import { scriptsTable } from "./scripts.js";
import { sourceTable } from "./source.js";
import { consoleTable } from "./console.js";
import { exceptionsTable } from "./exceptions.js";
import { asyncFramesTable } from "./async_frames.js";
import { listenersTable } from "./listeners.js";

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

export function getTable(name: string): VirtualTable | undefined {
	return tables.get(name);
}

export function listTables(): string[] {
	return Array.from(tables.keys());
}
