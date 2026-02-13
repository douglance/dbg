// Output formatting: TSV and JSON modes
// All output goes to stdout. Errors go to stderr.

export function formatTsv(columns: string[], rows: unknown[][]): string {
	const header = columns.join("\t");
	const body = rows.map((row) => row.map(formatCell).join("\t")).join("\n");
	return body ? `${header}\n${body}` : header;
}

export function formatJson(columns: string[], rows: unknown[][]): string {
	const objects = rows.map((row) => {
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < columns.length; i++) {
			obj[columns[i]] = row[i];
		}
		return obj;
	});
	return JSON.stringify(objects);
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(value);
}

export function formatFlowStatus(
	status: "paused" | "running",
	file?: string,
	line?: number,
	fn?: string,
): string {
	if (status === "running") return "running";
	return `paused\t${file ?? ""}\t${line ?? ""}\t${fn ?? ""}`;
}

export function formatBreakpointSet(
	id: string,
	file: string,
	line: number,
): string {
	return `${id}\t${file}\t${line}`;
}

export function formatBreakpointList(
	breakpoints: Array<{
		id: string;
		file: string;
		line: number;
		condition: string;
		hits: number;
	}>,
): string {
	const header = "id\tfile\tline\tcondition\thits";
	const rows = breakpoints
		.map(
			(bp) => `${bp.id}\t${bp.file}\t${bp.line}\t${bp.condition}\t${bp.hits}`,
		)
		.join("\n");
	return rows ? `${header}\n${rows}` : header;
}

export function formatSource(
	lines: Array<{ line: number; text: string }>,
	currentLine?: number,
): string {
	return lines
		.map((l) => {
			const marker = l.line === currentLine ? ">" : "";
			return `${l.line}${marker}\t${l.text}`;
		})
		.join("\n");
}

export function formatStatus(
	connected: boolean,
	paused: boolean,
	file?: string,
	line?: number,
	fn?: string,
	pid?: number | null,
	session?: string,
): string {
	const parts: string[] = [];
	if (session) parts.push(`[${session}]`);
	parts.push(connected ? "connected" : "disconnected");
	if (connected) {
		parts.push(paused ? "paused" : "running");
		if (paused && file) {
			parts.push(`${file}:${line}`);
			if (fn) parts.push(fn);
		}
	}
	if (pid) parts.push(`pid=${pid}`);
	return parts.join("\t");
}
