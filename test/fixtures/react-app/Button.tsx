// Component-harness fixture for `dbg shoot <Component.tsx>`: props change
// the rendered pixels, so two shoots with different --props must diff.

export default function Button({
	label = "click me",
	tone = "green",
}: {
	label?: string;
	tone?: string;
}) {
	return (
		<button
			type="button"
			style={{
				background: tone === "green" ? "#00a55a" : "#c1121f",
				color: "#ffffff",
				border: "none",
				borderRadius: "6px",
				padding: "12px 24px",
				fontSize: "16px",
			}}
		>
			{label}
		</button>
	);
}
