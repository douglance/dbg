// Command handlers for the debugger daemon
// Each handler receives the CDP client + daemon state and returns a Response

import type { CdpClientWrapper } from "./cdp/client.js";
import type { DaemonState, Response, StoredBreakpoint } from "./protocol.js";

// ─── Flow commands ───

export async function handleStatus(
	_cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	if (!state.connected) {
		return {
			ok: true,
			connected: false,
			status: undefined,
			pid: state.pid ?? undefined,
		};
	}
	const frame = state.callFrames[0];
	return {
		ok: true,
		connected: true,
		status: state.paused ? "paused" : "running",
		file: frame?.file,
		line: frame?.line,
		function: frame?.functionName,
		pid: state.pid ?? undefined,
	};
}

export async function handleContinue(
	cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };
	if (!state.paused) return { ok: false, error: "not paused" };

	const waitP = cdp.waitForPaused();
	await cdp.send("Debugger.resume");

	// Wait for next pause. If the program finishes, the promise will time out.
	// We use a short timeout here and return "running" if it doesn't pause.
	try {
		await Promise.race([
			waitP,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("running")), 5000),
			),
		]);
	} catch {
		return { ok: true, status: "running" };
	}

	const frame = state.callFrames[0];
	return {
		ok: true,
		status: "paused",
		file: frame?.file,
		line: frame?.line,
		function: frame?.functionName,
	};
}

export async function handleStepInto(
	cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	return stepCommand(cdp, state, "Debugger.stepInto");
}

export async function handleStepOver(
	cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	return stepCommand(cdp, state, "Debugger.stepOver");
}

export async function handleStepOut(
	cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	return stepCommand(cdp, state, "Debugger.stepOut");
}

async function stepCommand(
	cdp: CdpClientWrapper,
	state: DaemonState,
	method: string,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };
	if (!state.paused) return { ok: false, error: "not paused" };

	const waitP = cdp.waitForPaused();
	await cdp.send(method);
	await waitP;

	const frame = state.callFrames[0];
	return {
		ok: true,
		status: "paused",
		file: frame?.file,
		line: frame?.line,
		function: frame?.functionName,
	};
}

export async function handlePause(
	cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };
	if (state.paused) return { ok: false, error: "already paused" };

	const waitP = cdp.waitForPaused();
	await cdp.send("Debugger.pause");
	await waitP;

	const frame = state.callFrames[0];
	return {
		ok: true,
		status: "paused",
		file: frame?.file,
		line: frame?.line,
		function: frame?.functionName,
	};
}

// ─── Breakpoint commands ───

export async function handleSetBreakpoint(
	cdp: CdpClientWrapper,
	state: DaemonState,
	args: string,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };

	// Parse: file:line [if condition]
	const ifMatch = args.match(/^(.+?)\s+if\s+(.+)$/);
	let locationPart: string;
	let condition = "";

	if (ifMatch) {
		locationPart = ifMatch[1];
		condition = ifMatch[2];
	} else {
		locationPart = args;
	}

	const colonIdx = locationPart.lastIndexOf(":");
	if (colonIdx === -1) {
		return { ok: false, error: "expected file:line" };
	}

	const filePattern = locationPart.slice(0, colonIdx);
	const lineNum = Number.parseInt(locationPart.slice(colonIdx + 1), 10);
	if (Number.isNaN(lineNum)) {
		return { ok: false, error: "invalid line number" };
	}

	// Build a URL regex that matches the file pattern.
	// First check if we already know the script to get its exact URL.
	const scriptId = findScript(state, filePattern);
	const scriptInfo = scriptId ? state.scripts.get(scriptId) : undefined;

	// Use setBreakpointByUrl — this survives restarts because CDP
	// auto-applies it when matching scripts load.
	const urlRegex = scriptInfo
		? escapeRegex(scriptInfo.url)
		: `.*${escapeRegex(filePattern)}$`;

	try {
		const result = (await cdp.send("Debugger.setBreakpointByUrl", {
			lineNumber: lineNum,
			urlRegex,
			columnNumber: 0,
			...(condition ? { condition } : {}),
		})) as {
			breakpointId: string;
			locations: Array<{
				scriptId: string;
				lineNumber: number;
				columnNumber: number;
			}>;
		};

		const actualLine =
			result.locations.length > 0 ? result.locations[0].lineNumber : lineNum;

		const bp: StoredBreakpoint = {
			id: result.breakpointId,
			file: scriptInfo?.file ?? filePattern,
			line: actualLine,
			condition,
			hits: 0,
			enabled: true,
			cdpBreakpointId: result.breakpointId,
		};
		state.breakpoints.set(result.breakpointId, bp);

		return {
			ok: true,
			id: result.breakpointId,
			file: bp.file,
			line: bp.line,
		};
	} catch (e) {
		return { ok: false, error: `setBreakpoint failed: ${(e as Error).message}` };
	}
}

export async function handleDeleteBreakpoint(
	cdp: CdpClientWrapper,
	state: DaemonState,
	args: string,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };

	const bp = state.breakpoints.get(args);
	if (!bp) {
		return { ok: false, error: `breakpoint not found: ${args}` };
	}

	try {
		await cdp.send("Debugger.removeBreakpoint", {
			breakpointId: bp.cdpBreakpointId,
		});
		state.breakpoints.delete(args);
		return { ok: true, id: args };
	} catch (e) {
		return {
			ok: false,
			error: `removeBreakpoint failed: ${(e as Error).message}`,
		};
	}
}

export async function handleListBreakpoints(
	_cdp: CdpClientWrapper,
	state: DaemonState,
): Promise<Response> {
	const bps = Array.from(state.breakpoints.values());
	return {
		ok: true,
		columns: ["id", "file", "line", "condition", "hits"],
		rows: bps.map((bp) => [bp.id, bp.file, bp.line, bp.condition, bp.hits]),
	};
}

// ─── Eval ───

export async function handleEval(
	cdp: CdpClientWrapper,
	state: DaemonState,
	expression: string,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };

	try {
		let result: {
			result: { type: string; value?: unknown; description?: string; className?: string };
			exceptionDetails?: { text: string };
		};

		if (state.paused && state.callFrames.length > 0) {
			result = (await cdp.send("Debugger.evaluateOnCallFrame", {
				callFrameId: state.callFrames[0].callFrameId,
				expression,
				returnByValue: true,
			})) as typeof result;
		} else {
			result = (await cdp.send("Runtime.evaluate", {
				expression,
				returnByValue: true,
			})) as typeof result;
		}

		if (result.exceptionDetails) {
			return { ok: false, error: result.exceptionDetails.text };
		}

		const r = result.result;
		let value: string;
		if (r.value !== undefined) {
			value =
				typeof r.value === "string" ? r.value : JSON.stringify(r.value);
		} else {
			value = r.description ?? `[${r.type}]`;
		}

		return { ok: true, value, type: r.type };
	} catch (e) {
		return { ok: false, error: `eval failed: ${(e as Error).message}` };
	}
}

// ─── Source view ───

export async function handleSource(
	cdp: CdpClientWrapper,
	state: DaemonState,
	args?: string,
): Promise<Response> {
	if (!state.connected) return { ok: false, error: "not connected" };

	let scriptId: string | undefined;
	let startLine: number;
	let endLine: number;
	let currentLine: number | undefined;

	if (args) {
		// Parse: file startLine endLine
		const parts = args.split(/\s+/);
		if (parts.length === 3) {
			const matchedScriptId = findScript(state, parts[0]);
			if (!matchedScriptId) {
				return { ok: false, error: `no script matching "${parts[0]}"` };
			}
			scriptId = matchedScriptId;
			startLine = Number.parseInt(parts[1], 10);
			endLine = Number.parseInt(parts[2], 10);
		} else {
			return { ok: false, error: "expected: file startLine endLine" };
		}
	} else {
		// Use current paused location
		if (!state.paused || state.callFrames.length === 0) {
			return { ok: false, error: "not paused; specify file start end" };
		}
		const frame = state.callFrames[0];
		scriptId = frame.scriptId;
		currentLine = frame.line;
		// Show 10 lines around current position
		startLine = Math.max(0, currentLine - 5);
		endLine = currentLine + 5;
	}

	try {
		const { scriptSource } = (await cdp.send("Debugger.getScriptSource", {
			scriptId,
		})) as { scriptSource: string };

		const allLines = scriptSource.split("\n");
		const clampedStart = Math.max(0, startLine);
		const clampedEnd = Math.min(allLines.length - 1, endLine);

		const lines: Array<{ line: number; text: string }> = [];
		for (let i = clampedStart; i <= clampedEnd; i++) {
			lines.push({ line: i, text: allLines[i] });
		}

		// Format inline since we need to return structured data
		const formatted = lines
			.map((l) => {
				const marker = l.line === currentLine ? ">" : "";
				return `${l.line}${marker}\t${l.text}`;
			})
			.join("\n");

		return {
			ok: true,
			value: formatted,
		};
	} catch (e) {
		return {
			ok: false,
			error: `getScriptSource failed: ${(e as Error).message}`,
		};
	}
}

// ─── Helpers ───

function findScript(state: DaemonState, pattern: string): string | undefined {
	// Exact match on file path
	for (const [id, info] of state.scripts) {
		if (info.file === pattern || info.url === pattern) {
			return id;
		}
	}
	// Partial match: filename ends with pattern
	for (const [id, info] of state.scripts) {
		if (info.file.endsWith(pattern) || info.url.endsWith(pattern)) {
			return id;
		}
	}
	// Substring match on filename
	for (const [id, info] of state.scripts) {
		if (info.file.includes(pattern)) {
			return id;
		}
	}
	return undefined;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
