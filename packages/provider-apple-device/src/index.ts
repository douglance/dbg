import type { AttachRequest, ProviderResolutionResult } from "@dbg/types";

import {
	APPLE_DEVICE_PROVIDER,
	ATTACH_PLATFORMS,
	RESOLVED_ATTACH_PLATFORMS,
	asResolutionResult,
	attachRequestSchema,
	formatProviderError,
	parseAttachRequest,
	providerErrorSchema,
	providerResolutionResultSchema,
} from "./contracts.js";
import { listAppleAttachTargets, resolveAppleAttachTarget } from "./apple.js";
import { discoverDebugProxyPort } from "./devicectl.js";
import { AppleDeviceProviderError } from "./errors.js";
import { resolveVisionOsAttachTarget } from "./visionos.js";

export {
	APPLE_DEVICE_PROVIDER,
	ATTACH_PLATFORMS,
	RESOLVED_ATTACH_PLATFORMS,
	AppleDeviceProviderError,
	asResolutionResult,
	attachRequestSchema,
	listAppleAttachTargets,
	resolveAppleAttachTarget,
	discoverDebugProxyPort,
	formatProviderError,
	parseAttachRequest,
	providerErrorSchema,
	providerResolutionResultSchema,
	resolveVisionOsAttachTarget,
};

export function resolveAppleDeviceAttachTarget(
	request: AttachRequest,
): ProviderResolutionResult {
	if (request.provider !== APPLE_DEVICE_PROVIDER) {
		throw new AppleDeviceProviderError(
			"invalid_request",
			`unsupported provider: ${request.provider}`,
		);
	}
	return resolveAppleAttachTarget(request);
}
