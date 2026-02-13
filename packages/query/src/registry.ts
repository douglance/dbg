import type { DebugExecutor, SessionProtocol } from "@dbg/types";

import type { WhereExpr } from "./parser.js";

export interface VirtualTable {
	name: string;
	columns: string[];
	requiredFilters?: string[];
	protocols?: SessionProtocol[];
	fetch(
		where: WhereExpr | null,
		executor: DebugExecutor,
	): Promise<{ columns: string[]; rows: unknown[][] }>;
}

export interface QueryRegistry {
	register(table: VirtualTable): void;
	getTable(name: string, protocol?: SessionProtocol): VirtualTable | undefined;
	listTables(): string[];
}

export class TableRegistry implements QueryRegistry {
	private readonly tables = new Map<string, VirtualTable[]>();

	register(table: VirtualTable): void {
		const existing = this.tables.get(table.name) ?? [];
		existing.push(table);
		this.tables.set(table.name, existing);
	}

	getTable(name: string, protocol?: SessionProtocol): VirtualTable | undefined {
		const candidates = this.tables.get(name) ?? [];
		if (!protocol) return candidates[0];
		return candidates.find(
			(table) => !table.protocols || table.protocols.includes(protocol),
		);
	}

	listTables(): string[] {
		return Array.from(this.tables.keys());
	}
}

const defaultRegistry = new TableRegistry();

export function registerTable(table: VirtualTable): void {
	defaultRegistry.register(table);
}

export function getTable(
	name: string,
	protocol?: SessionProtocol,
): VirtualTable | undefined {
	return defaultRegistry.getTable(name, protocol);
}

export function listTables(): string[] {
	return defaultRegistry.listTables();
}

export function getDefaultRegistry(): QueryRegistry {
	return defaultRegistry;
}
