// React dev-build fixture for the blame e2e (bundled at test time by esbuild
// with NODE_ENV=development so __reactFiber$ expandos and component names
// survive). window.__mutateCard() flips ColorCard's padding + background.

import { useState } from "react";
import { createRoot } from "react-dom/client";

function Header() {
	return <h1 style={{ margin: 0, padding: "8px" }}>blame fixture</h1>;
}

function ColorCard() {
	const [mutated, setMutated] = useState(false);
	window.__mutateCard = () => setMutated(true);
	return (
		<div
			className="color-card"
			style={{
				padding: mutated ? "40px" : "8px",
				background: mutated ? "#c1121f" : "#00a55a",
				color: "#ffffff",
				width: "400px",
				height: "200px",
			}}
		>
			color card {mutated ? "after" : "before"}
		</div>
	);
}

function App() {
	return (
		<div>
			<Header />
			<ColorCard />
		</div>
	);
}

createRoot(document.getElementById("root")).render(<App />);
