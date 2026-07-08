# @dbg/adapter-visionos

VisionOS-specific debug adapter that resolves simulator processes and attaches via LLDB DAP. Wraps `@dbg/adapter-dap` with visionOS simulator process resolution.

## Public API

- `VisionOsClientWrapper`: Wraps `DapClientWrapper` with visionOS-specific attach logic.
  - `attachVisionOs(options)`: Resolve a visionOS simulator process, then attach LLDB to it. Returns `ResolvedVisionOsProcess`.
  - `connect()`, `disconnect()`, `send()`, `waitForPaused()`, `getState()`, `getStore()`: Delegated to inner DAP client.
- `VisionOsAttachOptions`: Combines `VisionOsProcessResolutionOptions` + `LldbAttachToPidOptions` (minus pid).
- `resolveVisionOsProcess(options)`: Find a visionOS process by bundle ID / PID in a booted simulator.
- `parseLaunchPid(output)`, `parsePsPid(output)`: Parse `simctl` output for process IDs.
- `ResolvedVisionOsProcess`, `VisionOsProcessResolutionOptions`: Types.

## Dependencies

- `@dbg/adapter-dap` (internal) -- `DapClientWrapper`, `LldbAttachToPidOptions`
- `@dbg/types` (internal) -- `DebuggerState`, `DAP_CAPABILITIES`, `SessionCapabilities`

## Dependents

- `@dbg/cli` -- previously used for visionOS attach (now superseded by `@dbg/provider-apple-device` for the unified attach flow)

## Testing

```sh
pnpm run build && vitest run
```
