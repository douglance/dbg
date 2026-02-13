import type { VirtualTable } from "@dbg/query";

function createStubTable(name: string): VirtualTable {
	return {
		name,
		columns: ["feature", "status", "message"],
		async fetch() {
			return {
				columns: ["feature", "status", "message"],
				rows: [[name, "stub", "table scaffolded; implementation pending"]],
			};
		},
	};
}

export const heapProfilerTable = createStubTable("heap_profiler");
export const cpuProfilerTable = createStubTable("cpu_profiler");
export const memoryTable = createStubTable("memory");
export const tracingTable = createStubTable("tracing");
export const accessibilityTable = createStubTable("accessibility");
export const indexedDbTable = createStubTable("indexeddb");
export const cacheStorageTable = createStubTable("cache_storage");
export const serviceWorkerTable = createStubTable("service_worker");
export const domDebuggerTable = createStubTable("dom_debugger");
export const domSnapshotTable = createStubTable("dom_snapshot");
export const animationTable = createStubTable("animation");
export const securityTable = createStubTable("security");
export const mediaTable = createStubTable("media");
export const layerTreeTable = createStubTable("layer_tree");
