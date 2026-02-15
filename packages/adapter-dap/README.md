# @dbg/adapter-dap

Debug Adapter Protocol (DAP) client for LLDB. Spawns `lldb-dap`, communicates over stdio, and translates DAP events into the shared `DebuggerState`.

## Public API

### Client (`client.ts`)
- `DapClientWrapper`: Implements `DebugExecutor`. Full DAP session lifecycle management.
  - `attachLldb(options)`: Launch a local program via `lldb-dap` with `stopOnEntry`.
  - `attachLldbToPid(options)`: Attach to a running process by PID (or via attachCommands for CoreDevice).
  - `attachLldbGdbRemote(options)`: Attach via gdb-remote protocol (port + optional PID).
  - `send(method, params?)`: Translate CDP-style method names to DAP requests (e.g., `Debugger.resume` -> `continue`).
  - `waitForPaused(timeoutMs?, minStopEpoch?)`: Promise that resolves on the next stopped event.
  - `disconnect()`: Send DAP disconnect, kill transport.
  - `getPhase()`: Current `DapSessionPhase` (starting, configuring, paused, running, terminated, error).
  - `getLastError()`: Last fatal error info.
- `LldbLaunchProgramOptions`, `LldbAttachToPidOptions`, `LldbGdbRemoteOptions`: Option interfaces.

### Transport (`transport.ts`)
- `DapTransport`: Low-level DAP message framing over child process stdio.
  - `request(command, arguments?, options?)`: Send a DAP request and await response.
  - `onEvent(event, handler)`: Register event listener (stopped, continued, terminated, etc.).
  - `onClose(handler)`: Transport close/error notification.
  - `close()`: Kill the child process.
- `DapTransportError`: Typed error with `DapTransportErrorCode` (timeout, protocol errors, process exit).

### Launch (`launch.ts`)
- `resolveLldbDapBinary(options?)`: Find `lldb-dap` via explicit path, `LLDB_DAP_PATH` env, `xcrun`, well-known paths, or PATH.
- `launchLldbDap(options?)`: Spawn `lldb-dap` child process with stdio pipes.
- `LldbLaunchOptions`: `{ lldbDapPath?, cwd?, env? }`.

## DAP-to-CDP Translation

The `send()` method accepts CDP-style method names and maps them internally:
- `Debugger.resume` -> `continue`
- `Debugger.stepInto` -> `stepIn`
- `Debugger.stepOver` -> `next`
- `Debugger.stepOut` -> `stepOut`
- `Runtime.evaluate` -> `evaluate`
- `Runtime.getProperties` -> `variables`
- `Debugger.setBreakpointByUrl` -> `setBreakpoints`
- `Debugger.getScriptSource` -> `source`

## Dependencies

- `@dbg/store` (internal) -- event recording
- `@dbg/types` (internal) -- `DebuggerState`, `DAP_CAPABILITIES`, `DebugExecutor`
- `@vscode/debugprotocol` (external) -- DAP protocol type definitions

## Dependents

- `@dbg/adapter-visionos` -- wraps `DapClientWrapper` for visionOS attach
- `@dbg/cli` -- creates `DapClientWrapper` for attach-lldb and attach commands

## Testing

```sh
pnpm run build && vitest run
```
