# @dbg/provider-apple-device

Apple device/simulator provider that resolves attach targets across iOS, tvOS, watchOS, and visionOS platforms. Handles device discovery, process resolution, and debug proxy port discovery.

## Public API

### Core
- `resolveAppleDeviceAttachTarget(request)`: Main entry point. Takes an `AttachRequest`, resolves device + process, returns `ProviderResolutionResult`.
- `resolveAppleAttachTarget(request)`: Lower-level resolver (called by the above).
- `listAppleAttachTargets(platform?)`: List available devices and simulators as attach candidates (for `dbg devices`).
- `parseAttachRequest(json)`: Parse and validate a JSON attach request string.

### Device Discovery (`apple.ts`, `simctl.ts`, `devicectl.ts`)
- `discoverDebugProxyPort(deviceId)`: Find the CoreDevice debug-proxy TCP port for a physical device (reads lockdown plist).
- `resolveVisionOsAttachTarget(request)`: VisionOS-specific resolution via simctl.

### Contracts (`contracts.ts`)
- `APPLE_DEVICE_PROVIDER`, `ATTACH_PLATFORMS`, `RESOLVED_ATTACH_PLATFORMS`: Constants.
- `attachRequestSchema`, `providerResolutionResultSchema`, `providerErrorSchema`: JSON schema objects.
- `asResolutionResult(request, deviceId, pid, metadata?)`: Build a `ProviderResolutionResult`.
- `formatProviderError(error)`: Format a `ProviderError` for display.

### Errors (`errors.ts`)
- `AppleDeviceProviderError`: Typed error with `ProviderErrorCode` and `toProviderError()` method.

## Device Selector Syntax

The `--device` flag supports:
- `sim:<name>` -- match booted simulator by name
- `device:<udid-or-name>` -- match physical device by UDID or name
- `<udid>` -- auto-detect simulator or device

## Dependencies

- `@dbg/types` (internal) -- `AttachRequest`, `ProviderResolutionResult`, `ProviderError`

## Dependents

- `@dbg/cli` -- used by daemon for `attach` and `devices` commands

## Testing

```sh
pnpm run build && vitest run
```
