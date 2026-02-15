import type {
	AttachPlatform,
	AttachProvider,
	AttachRequest,
	AttachStrategy,
	ProviderError,
	ProviderResolutionResult,
} from "@dbg/types";

export const APPLE_DEVICE_PROVIDER: AttachProvider = "apple-device";
export const ATTACH_PLATFORMS: AttachPlatform[] = [
	"auto",
	"ios",
	"tvos",
	"watchos",
	"visionos",
];
export const RESOLVED_ATTACH_PLATFORMS: Exclude<AttachPlatform, "auto">[] = [
	"ios",
	"tvos",
	"watchos",
	"visionos",
];
const ATTACH_STRATEGIES: AttachStrategy[] = [
	"auto",
	"device-process",
	"gdb-remote",
];

export const attachRequestSchema: Record<string, unknown> = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://dbg.dev/schemas/AttachRequest.schema.json",
	title: "AttachRequest",
	type: "object",
	additionalProperties: false,
	required: ["provider", "bundleId"],
	properties: {
		provider: { type: "string", enum: [APPLE_DEVICE_PROVIDER] },
		platform: { type: "string", enum: ATTACH_PLATFORMS },
		bundleId: { type: "string", minLength: 1 },
		device: { type: "string", minLength: 1 },
		pid: { type: "integer", minimum: 1 },
		launch: { type: "boolean" },
		protocol: { type: "string", enum: ["dap", "cdp"] },
		attachStrategy: { type: "string", enum: ATTACH_STRATEGIES },
		attachTimeoutMs: { type: "integer", minimum: 1 },
		verbose: { type: "boolean" },
	},
};

export const providerResolutionResultSchema: Record<string, unknown> = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://dbg.dev/schemas/ProviderResolutionResult.schema.json",
	title: "ProviderResolutionResult",
	type: "object",
	additionalProperties: false,
	required: [
		"provider",
		"platform",
		"deviceId",
		"bundleId",
		"pid",
		"attachProtocol",
	],
	properties: {
		provider: { type: "string", enum: [APPLE_DEVICE_PROVIDER] },
		platform: { type: "string", enum: RESOLVED_ATTACH_PLATFORMS },
		deviceId: { type: "string", minLength: 1 },
		bundleId: { type: "string", minLength: 1 },
		pid: { type: "integer", minimum: 1 },
		attachProtocol: { type: "string", enum: ["dap"] },
		metadata: { type: "object", additionalProperties: true },
	},
};

export const providerErrorSchema: Record<string, unknown> = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://dbg.dev/schemas/ProviderError.schema.json",
	title: "ProviderError",
	type: "object",
	additionalProperties: false,
	required: ["code", "message"],
	properties: {
		code: {
			type: "string",
			enum: [
				"invalid_request",
				"device_not_found",
				"app_not_installed",
				"process_not_running",
				"attach_denied_or_timeout",
				"lldb_dap_unavailable",
				"provider_error",
			],
		},
		message: { type: "string", minLength: 1 },
		details: { type: "object", additionalProperties: true },
	},
};

export function parseAttachRequest(raw: string): AttachRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("attach request must be valid JSON");
	}
	if (!isRecord(parsed)) {
		throw new Error("attach request must be an object");
	}

	const provider = parsed.provider;
	const platform = parsed.platform;
	const bundleId = parsed.bundleId;

	if (provider !== APPLE_DEVICE_PROVIDER) {
		throw new Error(`unsupported provider: ${String(provider)}`);
	}
	if (
		platform !== undefined &&
		(!ATTACH_PLATFORMS.includes(platform as AttachPlatform) ||
			typeof platform !== "string")
	) {
		throw new Error(
			`unsupported platform: ${String(platform)}. Supported: ${ATTACH_PLATFORMS.join(", ")}`,
		);
	}
	if (typeof bundleId !== "string" || bundleId.trim() === "") {
		throw new Error("bundleId is required");
	}

	const request: AttachRequest = {
		provider,
		platform:
			typeof platform === "string" ? (platform as AttachPlatform) : "auto",
		bundleId: bundleId.trim(),
		protocol: "dap",
	};

	if (typeof parsed.device === "string" && parsed.device.trim() !== "") {
		request.device = parsed.device.trim();
	}
	if (parsed.pid !== undefined) {
		const pid = Number(parsed.pid);
		if (!Number.isInteger(pid) || pid <= 0) {
			throw new Error("pid must be a positive integer");
		}
		request.pid = pid;
	}
	if (typeof parsed.launch === "boolean") {
		request.launch = parsed.launch;
	}
	if (parsed.protocol === "dap" || parsed.protocol === "cdp") {
		request.protocol = parsed.protocol;
	}
	if (
		typeof parsed.attachStrategy === "string" &&
		ATTACH_STRATEGIES.includes(parsed.attachStrategy as AttachStrategy)
	) {
		request.attachStrategy = parsed.attachStrategy as AttachStrategy;
	} else if (parsed.attachStrategy !== undefined) {
		throw new Error(
			`attachStrategy must be one of: ${ATTACH_STRATEGIES.join(", ")}`,
		);
	}
	if (parsed.attachTimeoutMs !== undefined) {
		const timeoutMs = Number(parsed.attachTimeoutMs);
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
			throw new Error("attachTimeoutMs must be a positive integer");
		}
		request.attachTimeoutMs = timeoutMs;
	}
	if (typeof parsed.verbose === "boolean") {
		request.verbose = parsed.verbose;
	}

	return request;
}

export function formatProviderError(error: ProviderError): string {
	return `${error.code}: ${error.message}`;
}

export function asResolutionResult(
	value: ProviderResolutionResult,
): ProviderResolutionResult {
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
