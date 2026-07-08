// Accessibility rules over a CDP `Accessibility.getFullAXTree` result.
//
// Computes five high-signal issues per capture. Selectors are AX descriptors
// (`role#ordinal`, ordinal = position among same-role nodes in tree order) —
// stable across reloads (unlike backendDOMNodeId), so `dbg after` can diff an
// anchor's issues against the after's and report only genuinely NEW ones. Pure.

export interface AxValue {
	value?: unknown;
}

export interface AxProperty {
	name?: string;
	value?: AxValue;
}

export interface AxNode {
	nodeId?: string;
	ignored?: boolean;
	role?: AxValue;
	name?: AxValue;
	properties?: AxProperty[];
	backendDOMNodeId?: number;
}

export interface AxTree {
	nodes?: AxNode[];
}

export interface A11yIssue {
	rule: string;
	selector: string;
	detail: string;
}

const IMAGE_ROLES = new Set(["image", "img", "graphics-symbol"]);
const NAMED_INTERACTIVE = new Set(["button", "link"]);
const LABELLED_CONTROLS = new Set([
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"combobox",
	"listbox",
	"slider",
	"spinbutton",
	"switch",
	"menuitemcheckbox",
	"menuitemradio",
]);
const LANDMARK_ROLES = new Set([
	"navigation",
	"banner",
	"main",
	"contentinfo",
	"complementary",
	"region",
	"form",
	"search",
]);

function roleOf(node: AxNode): string {
	return typeof node.role?.value === "string" ? node.role.value : "";
}

function nameOf(node: AxNode): string {
	return typeof node.name?.value === "string" ? node.name.value.trim() : "";
}

/** Compute the five a11y issues for one AX tree. */
export function computeA11yIssues(tree: AxTree): A11yIssue[] {
	const nodes = (tree.nodes ?? []).filter((n) => !n.ignored);
	const issues: A11yIssue[] = [];
	// Per-role running ordinal → stable selectors across reloads.
	const roleCounts = new Map<string, number>();
	const ordinal = (role: string): number => {
		const next = roleCounts.get(role) ?? 0;
		roleCounts.set(role, next + 1);
		return next;
	};
	// Landmark bookkeeping for the duplicate-landmark rule.
	const landmarksByRole = new Map<string, AxNode[]>();

	for (const node of nodes) {
		const role = roleOf(node);
		if (role === "") continue;
		const name = nameOf(node);
		const ord = ordinal(role);
		const selector = `${role}#${ord}`;

		if (IMAGE_ROLES.has(role) && name === "") {
			issues.push({
				rule: "image-missing-alt",
				selector,
				detail: "image has no accessible name (alt text)",
			});
		} else if (NAMED_INTERACTIVE.has(role) && name === "") {
			issues.push({
				rule: "control-missing-name",
				selector,
				detail: `${role} has no accessible name`,
			});
		} else if (LABELLED_CONTROLS.has(role) && name === "") {
			issues.push({
				rule: "control-missing-label",
				selector,
				detail: `${role} control has no label`,
			});
		}

		if (LANDMARK_ROLES.has(role)) {
			const list = landmarksByRole.get(role) ?? [];
			list.push(node);
			landmarksByRole.set(role, list);
		}

		if (role === "RootWebArea" && name === "") {
			issues.push({
				rule: "document-missing-title",
				selector: "RootWebArea#0",
				detail: "document has no title",
			});
		}
	}

	// Duplicate landmarks: >1 of the same role sharing an (empty) accessible
	// name are ambiguous to AT users. Flag the 2nd+ occurrence.
	for (const [role, list] of landmarksByRole) {
		if (list.length < 2) continue;
		const byName = new Map<string, number>();
		let dupOrdinal = 0;
		for (const node of list) {
			const key = nameOf(node);
			const count = byName.get(key) ?? 0;
			byName.set(key, count + 1);
			if (key === "" && count >= 1) {
				issues.push({
					rule: "duplicate-landmark",
					selector: `${role}#dup${dupOrdinal++}`,
					detail: `duplicate unnamed <${role}> landmark`,
				});
			}
		}
	}

	return issues;
}
