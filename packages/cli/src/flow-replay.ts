import type { DebugExecutor } from "@dbg/types";

export interface ActionableResult {
	ready: boolean;
	selector: string | null;
	reason: string;
	cx: number | null;
	cy: number | null;
}

interface LocatedNode {
	nodeId: number;
	selector: string;
}

async function locateNode(
	cdp: DebugExecutor,
	selector: string | null | undefined,
	fallbackPath: string | null | undefined,
): Promise<LocatedNode> {
	const candidates = [selector, fallbackPath].filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
	if (candidates.length === 0) throw new Error("step has no selector");
	const doc = (await cdp.send("DOM.getDocument", {
		depth: 0,
	})) as { root: { nodeId: number } };
	for (const candidate of candidates) {
		const found = (await cdp.send("DOM.querySelector", {
			nodeId: doc.root.nodeId,
			selector: candidate,
		})) as { nodeId: number };
		if (found.nodeId) return { nodeId: found.nodeId, selector: candidate };
	}
	throw new Error(`no element matches: ${candidates.join(" or ")}`);
}

export async function waitForActionable(
	cdp: DebugExecutor,
	selector: string | null | undefined,
	fallbackPath: string | null | undefined,
	timeoutMs: number,
): Promise<ActionableResult> {
	const deadline = Date.now() + timeoutMs;
	let last: ActionableResult = {
		ready: false,
		selector: selector ?? fallbackPath ?? null,
		reason: "not checked",
		cx: null,
		cy: null,
	};
	while (Date.now() <= deadline) {
		last = await actionableOnce(cdp, selector, fallbackPath);
		if (last.ready) return last;
		await sleep(100);
	}
	return last;
}

async function actionableOnce(
	cdp: DebugExecutor,
	selector: string | null | undefined,
	fallbackPath: string | null | undefined,
): Promise<ActionableResult> {
	const expression = `(() => {
		const candidates = ${JSON.stringify([selector, fallbackPath])}.filter(Boolean);
		for (const selector of candidates) {
			let el = null;
			try { el = document.querySelector(selector); } catch (_e) {}
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			if (!rect.width || !rect.height) return { ready:false, selector, reason:'zero-size', cx:null, cy:null };
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const hit = document.elementFromPoint(cx, cy);
			if (!hit) return { ready:false, selector, reason:'not hit-testable', cx, cy };
			const visible = hit === el || el.contains(hit) || hit.contains(el);
			if (!visible) return { ready:false, selector, reason:'covered by ' + (hit.tagName || 'node'), cx, cy };
			return { ready:true, selector, reason:'ready', cx, cy };
		}
		return { ready:false, selector:candidates[0] || null, reason:'not found', cx:null, cy:null };
	})()`;
	try {
		const res = (await cdp.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
		})) as { result?: { value?: ActionableResult } };
		return normalizeActionable(res.result?.value);
	} catch (e) {
		return {
			ready: false,
			selector: selector ?? fallbackPath ?? null,
			reason: (e as Error).message,
			cx: null,
			cy: null,
		};
	}
}

function normalizeActionable(value: unknown): ActionableResult {
	if (!value || typeof value !== "object") {
		return {
			ready: false,
			selector: null,
			reason: "invalid readiness result",
			cx: null,
			cy: null,
		};
	}
	const v = value as Record<string, unknown>;
	return {
		ready: v.ready === true,
		selector: typeof v.selector === "string" ? v.selector : null,
		reason: typeof v.reason === "string" ? v.reason : "unknown",
		cx: typeof v.cx === "number" ? v.cx : null,
		cy: typeof v.cy === "number" ? v.cy : null,
	};
}

export async function replayClick(
	cdp: DebugExecutor,
	selector: string | null | undefined,
	fallbackPath: string | null | undefined,
): Promise<void> {
	const located = await locateNode(cdp, selector, fallbackPath);
	try {
		await cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId: located.nodeId });
	} catch {
		// Older Chrome may omit this method; the page-level readiness poll still
		// guards against non-actionable nodes.
	}
	const { x, y } = await nodeCenter(cdp, located.nodeId);
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button: "left",
		clickCount: 1,
	});
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button: "left",
		clickCount: 1,
	});
}

export async function replayInput(
	cdp: DebugExecutor,
	selector: string | null | undefined,
	fallbackPath: string | null | undefined,
	value: string,
): Promise<void> {
	const located = await locateNode(cdp, selector, fallbackPath);
	await cdp.send("DOM.focus", { nodeId: located.nodeId });
	await cdp.send("Input.insertText", { text: value });
}

export async function replayKeypress(
	cdp: DebugExecutor,
	selector: string | null | undefined,
	fallbackPath: string | null | undefined,
	value: string,
): Promise<void> {
	if (selector || fallbackPath) {
		const located = await locateNode(cdp, selector, fallbackPath);
		await cdp.send("DOM.focus", { nodeId: located.nodeId });
	}
	const key = keyPayload(value);
	await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

export async function replayScroll(
	cdp: DebugExecutor,
	value: string,
): Promise<void> {
	const y = Number.parseFloat(value);
	await cdp.send("Runtime.evaluate", {
		expression: `window.scrollTo(0, ${Number.isFinite(y) ? y : 0})`,
	});
}

async function nodeCenter(
	cdp: DebugExecutor,
	nodeId: number,
): Promise<{ x: number; y: number }> {
	try {
		const quads = (await cdp.send("DOM.getContentQuads", {
			nodeId,
		})) as { quads?: number[][] };
		const quad = quads.quads?.[0];
		if (quad && quad.length >= 8) {
			return {
				x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
				y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
			};
		}
	} catch {
		// fall through to box model
	}
	const box = (await cdp.send("DOM.getBoxModel", {
		nodeId,
	})) as { model: { content: number[] } };
	const quad = box.model.content;
	return {
		x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
		y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
	};
}

function keyPayload(value: string): {
	key: string;
	code: string;
	text?: string;
} {
	switch (value) {
		case "Enter":
			return { key: "Enter", code: "Enter", text: "\r" };
		case "Tab":
			return { key: "Tab", code: "Tab", text: "\t" };
		case "Escape":
			return { key: "Escape", code: "Escape" };
		case "ArrowUp":
		case "ArrowDown":
		case "ArrowLeft":
		case "ArrowRight":
			return { key: value, code: value };
		default:
			return { key: value, code: value, text: value };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
