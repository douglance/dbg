// FS-watch path filter (visual flight recorder, Phase 2).
//
// Decides which relative paths reported by the recorder's recursive fs.watch
// count as project edits (changed-file annotations + auto-epoch boundaries).

const IGNORED_SEGMENTS = new Set([
	"node_modules",
	".git",
	".dbg",
	"dist",
	"build",
	"coverage",
]);

/** True when a watch-relative path should be ignored (build output, VCS
 * internals, recorder artifacts, or any dotfile/dot-directory). */
export function isIgnoredWatchPath(relPath: string): boolean {
	const segments = relPath.split(/[\\/]+/).filter(Boolean);
	if (segments.length === 0) return true;
	for (const segment of segments) {
		if (IGNORED_SEGMENTS.has(segment)) return true;
		if (segment.startsWith(".")) return true;
	}
	return false;
}
