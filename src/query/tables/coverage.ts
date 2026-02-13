// Code coverage table — on-demand via CDP calls

import type { CssCoverageEntry, JsCoverageScript } from "../../protocol.js";
import type { VirtualTable } from "./index.js";

export const coverageTable: VirtualTable = {
	name: "coverage",
	columns: ["url", "total_bytes", "used_bytes", "used_pct"],
	async fetch(_where, executor) {
		const rows: unknown[][] = [];
		const state = executor.getState();

		let jsCoverage: JsCoverageScript[] = [];
		let cssCoverage: CssCoverageEntry[] = [];
		let hasLiveCoverage = false;

		try {
			const jsResult = (await executor.send(
				"Profiler.takePreciseCoverage",
				{},
			)) as { result: JsCoverageScript[] };
			jsCoverage = jsResult.result ?? [];
			hasLiveCoverage = true;
		} catch {
			// Coverage not started or not available
		}

		try {
			const cssResult = (await executor.send("CSS.takeCoverageDelta", {})) as {
				coverage: CssCoverageEntry[];
			};
			cssCoverage = cssResult.coverage ?? [];
			hasLiveCoverage = true;
		} catch {
			// CSS coverage not available
		}

		if (!hasLiveCoverage && state.coverageSnapshot) {
			jsCoverage = state.coverageSnapshot.js;
			cssCoverage = state.coverageSnapshot.css;
		}

		appendJsCoverage(rows, jsCoverage);
		appendCssCoverage(rows, cssCoverage);

		return { columns: this.columns, rows };
	},
};

function appendJsCoverage(
	rows: unknown[][],
	scripts: JsCoverageScript[],
): void {
	for (const script of scripts) {
		if (!script.url) continue;
		let totalBytes = 0;
		let usedBytes = 0;
		for (const fn of script.functions) {
			for (const range of fn.ranges) {
				const size = range.endOffset - range.startOffset;
				totalBytes += size;
				if (range.count > 0) usedBytes += size;
			}
		}
		if (totalBytes > 0) {
			rows.push([
				script.url,
				totalBytes,
				usedBytes,
				Math.round((usedBytes / totalBytes) * 100),
			]);
		}
	}
}

function appendCssCoverage(
	rows: unknown[][],
	coverage: CssCoverageEntry[],
): void {
	// Group by styleSheetId
	const cssMap = new Map<string, { total: number; used: number }>();
	for (const entry of coverage) {
		const size = entry.endOffset - entry.startOffset;
		let existing = cssMap.get(entry.styleSheetId);
		if (!existing) {
			existing = { total: 0, used: 0 };
			cssMap.set(entry.styleSheetId, existing);
		}
		existing.total += size;
		if (entry.used) existing.used += size;
	}

	for (const [sheetId, data] of cssMap) {
		if (data.total > 0) {
			rows.push([
				`css:${sheetId}`,
				data.total,
				data.used,
				Math.round((data.used / data.total) * 100),
			]);
		}
	}
}
