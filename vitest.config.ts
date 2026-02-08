import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 15000,
		// E2E tests share /tmp/dbg.sock — must not run in parallel
		fileParallelism: false,
	},
});
