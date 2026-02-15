import type { AttachRequest, ProviderResolutionResult } from "@dbg/types";

import { APPLE_DEVICE_PROVIDER } from "./contracts.js";
import { AppleDeviceProviderError } from "./errors.js";
import { resolveAppleAttachTarget } from "./apple.js";

export function resolveVisionOsAttachTarget(
	request: AttachRequest,
): ProviderResolutionResult {
	if (request.provider !== APPLE_DEVICE_PROVIDER) {
		throw new AppleDeviceProviderError(
			"invalid_request",
			`unsupported provider: ${request.provider}`,
		);
	}
	return resolveAppleAttachTarget({
		...request,
		platform: "visionos",
	});
}
