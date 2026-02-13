// Cookies table — fetches browser cookies via Network.getCookies
// No filter required

import type { VirtualTable } from "@dbg/query";

export const cookiesTable: VirtualTable = {
	name: "cookies",
	columns: [
		"name",
		"value",
		"domain",
		"path",
		"expires",
		"size",
		"http_only",
		"secure",
		"same_site",
	],
	async fetch(_where, executor) {
		try {
			const result = (await executor.send("Network.getCookies", {})) as {
				cookies: Array<{
					name: string;
					value: string;
					domain: string;
					path: string;
					expires: number;
					size: number;
					httpOnly: boolean;
					secure: boolean;
					sameSite: string;
				}>;
			};

			const rows: unknown[][] = result.cookies.map((c) => [
				c.name,
				c.value,
				c.domain,
				c.path,
				c.expires,
				c.size,
				c.httpOnly,
				c.secure,
				c.sameSite,
			]);

			return { columns: this.columns, rows };
		} catch {
			return { columns: this.columns, rows: [] };
		}
	},
};
