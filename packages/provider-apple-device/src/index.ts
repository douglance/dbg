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
import { discoverDebugProxyPort, listApps } from "./devicectl.js";
import type { AppRecord } from "./devicectl.js";
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
	listApps,
	resolveAppleAttachTarget,
	discoverDebugProxyPort,
	formatProviderError,
	parseAttachRequest,
	providerErrorSchema,
	providerResolutionResultSchema,
	resolveVisionOsAttachTarget,
};
export type { AppRecord };

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
