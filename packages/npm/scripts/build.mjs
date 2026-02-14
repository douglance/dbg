import { build } from "esbuild";

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoRoot = resolve(packageDir, "../..");

const outdir = join(packageDir, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Keep npm package README/LICENSE in sync with repo root.
copyFileSync(join(repoRoot, "README.md"), join(packageDir, "README.md"));
copyFileSync(join(repoRoot, "LICENSE"), join(packageDir, "LICENSE"));

const cliEntry = join(repoRoot, "packages/cli/dist/cli.js");
const daemonEntry = join(repoRoot, "packages/cli/dist/daemon.js");

if (!existsSync(cliEntry) || !existsSync(daemonEntry)) {
	throw new Error(
		[
			"missing build artifacts needed for release bundle.",
			"Run: pnpm build",
			`Missing: ${!existsSync(cliEntry) ? cliEntry : ""} ${!existsSync(daemonEntry) ? daemonEntry : ""}`.trim(),
		].join(" "),
	);
}

await build({
	entryPoints: [cliEntry, daemonEntry],
	outdir,
	platform: "node",
	target: ["node22"],
	format: "esm",
	bundle: true,
	splitting: false,
	sourcemap: true,
	// Keep CRI as a normal dependency (dynamic import in adapter-cdp).
	external: ["chrome-remote-interface"],
	logLevel: "info",
});
