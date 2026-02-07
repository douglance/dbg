declare module "chrome-remote-interface" {
	function CDP(options: { target: string; local?: boolean }): Promise<CDP.Client>;
	namespace CDP {
		interface Client {
			close(): Promise<void>;
			send(method: string, params?: Record<string, unknown>): Promise<unknown>;
			on(event: string, listener: (...args: unknown[]) => void): Client;
			once(event: string, listener: (...args: unknown[]) => void): Client;
			removeListener(event: string, listener: (...args: unknown[]) => void): Client;
			Debugger: {
				enable(): Promise<void>;
				disable(): Promise<void>;
			};
			Runtime: {
				enable(): Promise<void>;
				disable(): Promise<void>;
			};
		}
	}
	export default CDP;
}
