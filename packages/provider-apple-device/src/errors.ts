import type { ProviderError, ProviderErrorCode } from "@dbg/types";

export class AppleDeviceProviderError extends Error {
	readonly code: ProviderErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(
		code: ProviderErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AppleDeviceProviderError";
		this.code = code;
		this.details = details;
	}

	toProviderError(): ProviderError {
		return {
			code: this.code,
			message: this.message,
			details: this.details,
		};
	}
}
