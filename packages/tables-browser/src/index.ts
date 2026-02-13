import type { QueryRegistry, VirtualTable } from "@dbg/query";

import { cookiesTable } from "./cookies.js";
import { coverageTable } from "./coverage.js";
import { domTable } from "./dom.js";
import { networkTable } from "./network.js";
import { networkBodyTable } from "./network_body.js";
import { networkHeadersTable } from "./network_headers.js";
import { pageEventsTable } from "./page_events.js";
import { performanceTable } from "./performance.js";
import { storageTable } from "./storage.js";
import {
	accessibilityTable,
	animationTable,
	cacheStorageTable,
	cpuProfilerTable,
	domDebuggerTable,
	domSnapshotTable,
	heapProfilerTable,
	indexedDbTable,
	layerTreeTable,
	mediaTable,
	memoryTable,
	securityTable,
	serviceWorkerTable,
	tracingTable,
} from "./stubs.js";
import { stylesTable } from "./styles.js";
import { wsFramesTable } from "./ws_frames.js";

export {
	accessibilityTable,
	animationTable,
	cacheStorageTable,
	cookiesTable,
	coverageTable,
	cpuProfilerTable,
	domTable,
	domDebuggerTable,
	domSnapshotTable,
	heapProfilerTable,
	indexedDbTable,
	layerTreeTable,
	mediaTable,
	memoryTable,
	networkTable,
	networkBodyTable,
	networkHeadersTable,
	pageEventsTable,
	performanceTable,
	securityTable,
	serviceWorkerTable,
	storageTable,
	stylesTable,
	tracingTable,
	wsFramesTable,
};

export function registerBrowserTables(registry: QueryRegistry): void {
	for (const table of [
		networkTable,
		networkHeadersTable,
		networkBodyTable,
		pageEventsTable,
		domTable,
		stylesTable,
		performanceTable,
		cookiesTable,
		storageTable,
		wsFramesTable,
		coverageTable,
		heapProfilerTable,
		cpuProfilerTable,
		memoryTable,
		tracingTable,
		accessibilityTable,
		indexedDbTable,
		cacheStorageTable,
		serviceWorkerTable,
		domDebuggerTable,
		domSnapshotTable,
		animationTable,
		securityTable,
		mediaTable,
		layerTreeTable,
	]) {
		registerCdpOnly(registry, table);
	}
}

function registerCdpOnly(registry: QueryRegistry, table: VirtualTable): void {
	registry.register({ ...table, protocols: ["cdp"] });
}
