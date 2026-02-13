import type { VirtualTable } from "@dbg/query";

export const modulesTable: VirtualTable = {
	name: "modules",
	columns: ["id", "name", "path", "base_address", "size"],
	async fetch(_where, executor) {
		const state = executor.getState();
		if (state.dap?.modules?.length) {
			return {
				columns: this.columns,
				rows: state.dap.modules.map((moduleInfo) => [
					moduleInfo.id,
					moduleInfo.name,
					moduleInfo.path,
					moduleInfo.baseAddress,
					moduleInfo.size,
				]),
			};
		}

		const response = (await executor.send("modules")) as {
			modules?: Array<{
				id?: string | number;
				name?: string;
				path?: string;
				baseAddress?: string;
				size?: number;
			}>;
		};
		return {
			columns: this.columns,
			rows: (response.modules ?? []).map((moduleInfo) => [
				String(moduleInfo.id ?? ""),
				moduleInfo.name ?? "",
				moduleInfo.path ?? "",
				moduleInfo.baseAddress ?? "",
				moduleInfo.size ?? 0,
			]),
		};
	},
};
