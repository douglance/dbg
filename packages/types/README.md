# @dbg/types

Shared TypeScript types and constants used across all dbg packages.

## Public API

- `SOCKET_PATH`: Unix socket path for CLI-daemon communication (default `/tmp/dbg.sock`, override via `DBG_SOCK`).
- `SessionProtocol`: `"cdp" | "dap"` -- which debug protocol a session uses.
- `AttachProvider`, `AttachPlatform`, `AttachStrategy`: Enums for Apple device attach configuration.
- `AttachRequest`: Full attach request payload (provider, platform, bundleId, device, pid, etc.).
- `ProviderResolutionResult`: Result of resolving an attach target (deviceId, pid, protocol).
- `ProviderError`, `ProviderErrorCode`: Structured error from a provider.
- `AttachDiagnostics`: Timing and strategy info from an attach attempt.
- `SessionCapabilities`: Feature flags (breakpoints, stepping, dom, registers, etc.) per session type.
- `EventStoreLike`: Interface for the event store (query + record).
- `DebugExecutor`: Unified interface for sending debug commands (CDP or DAP).
- `Command`: Discriminated union of all CLI-to-daemon wire protocol commands.
- `Response`, `OkResponse`, `ErrResponse`: Daemon-to-CLI response types.
- `DebuggerState` (alias `DaemonState`): Full debugger state (connected, paused, callFrames, scripts, breakpoints, console, exceptions, cdp/dap substates).
- `Session`, `SessionInfo`: Runtime session and its serializable info.
- `CDP_CAPABILITIES`, `DAP_CAPABILITIES`: Default capability sets for each protocol.
- `createEmptyDebuggerState()`: Factory for a fresh `DebuggerState`.
- Supporting interfaces: `CallFrameInfo`, `ScopeInfo`, `AsyncFrameInfo`, `StoredBreakpoint`, `ScriptInfo`, `ConsoleEntry`, `ExceptionEntry`, `NetworkRequest`, `PageEvent`, `WebSocketFrame`, `CoverageSnapshot`, `ThreadInfo`, `RegisterGroup`, `ModuleInfo`, `DapStopInfo`, `DapErrorInfo`, `CdpState`, `DapState`.

## Dependencies

None.

## Dependents

- `@dbg/store` -- uses `EventStoreLike` interface
- `@dbg/query` -- uses `DebugExecutor`, `SessionProtocol`
- `@dbg/adapter-cdp` -- uses `DebuggerState`, `DebugExecutor`, `CDP_CAPABILITIES`
- `@dbg/adapter-dap` -- uses `DebuggerState`, `DebugExecutor`, `DAP_CAPABILITIES`
- `@dbg/adapter-visionos` -- uses `DebuggerState`, `DAP_CAPABILITIES`
- `@dbg/tables-core` -- uses `DebugExecutor`
- `@dbg/tables-browser` -- uses `DebugExecutor`
- `@dbg/tables-native` -- uses `DebugExecutor`
- `@dbg/provider-apple-device` -- uses `AttachRequest`, `ProviderResolutionResult`
- `@dbg/cli` -- uses `Command`, `Response`, `Session`, `SOCKET_PATH`

## Testing

```sh
pnpm run build && vitest run
```
