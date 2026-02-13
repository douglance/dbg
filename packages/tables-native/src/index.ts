import type { QueryRegistry, VirtualTable } from "@dbg/query";

import { disassemblyTable } from "./disassembly.js";
import { memoryTable } from "./memory.js";
import { modulesTable } from "./modules.js";
import { registersTable } from "./registers.js";
import { signalsTable } from "./signals.js";
import { threadsTable } from "./threads.js";
import { watchpointsTable } from "./watchpoints.js";

export {
	disassemblyTable,
	memoryTable,
	modulesTable,
	registersTable,
	signalsTable,
	threadsTable,
	watchpointsTable,
};

export function registerNativeTables(registry: QueryRegistry): void {
	for (const table of [
		registersTable,
		memoryTable,
		disassemblyTable,
		threadsTable,
		modulesTable,
		watchpointsTable,
		signalsTable,
	]) {
		registerDapOnly(registry, table);
	}
}

function registerDapOnly(registry: QueryRegistry, table: VirtualTable): void {
	registry.register({ ...table, protocols: ["dap"] });
}
