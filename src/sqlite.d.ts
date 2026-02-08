declare module "node:sqlite" {
	export class DatabaseSync {
		constructor(path?: string);
		exec(sql: string): void;
		prepare(sql: string): StatementSync;
		close(): void;
	}

	export class StatementSync {
		run(...params: unknown[]): {
			changes: number;
			lastInsertRowid: number | bigint;
		};
		all(...params: unknown[]): Record<string, unknown>[];
		get(...params: unknown[]): Record<string, unknown> | undefined;
	}
}
