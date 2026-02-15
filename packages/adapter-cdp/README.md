# @dbg/adapter-cdp

Chrome DevTools Protocol (CDP) client wrapper and target discovery. Connects to V8 Inspector targets (Node.js, Deno, browsers) over WebSocket.

## Public API

### Client (`client.ts`)
- `CdpClientWrapper`: Implements `DebugExecutor`. Manages a CDP connection and tracks all debugger state.
  - `connect(wsUrl, targetType?)`: Connect to a WebSocket debugger URL. Enables Debugger, Runtime, and (for page targets) browser domains.
  - `disconnect()`: Close the connection and reset state.
  - `send(method, params?)`: Send a CDP command and await the response. Records to event store.
  - `getState()`: Return the current `DebuggerState`.
  - `getStore()`: Return the `EventStore` (or null).
  - `waitForPaused(timeoutMs?)`: Promise that resolves on the next `Debugger.paused` event.
  - `isConnected()`: Boolean check.
  - `addMockRule(urlPattern, body, status)`, `removeMockRule()`, `clearMockRules()`: Network interception via Fetch domain.

### Discovery (`discovery.ts`)
- `discoverTarget(port, host?, targetType?)`: Hit `/json` endpoint, auto-detect node vs page target, return `{ wsUrl, type }`.
- `listTargets(port, host?)`: Return all debuggable targets as `TargetListEntry[]`.
- `TargetType`: `"node" | "page"`.
- `DiscoveredTarget`: `{ wsUrl, type }`.
- `TargetListEntry`: `{ id, type, title, url }`.

## Event Handling

Automatically tracks: `Debugger.paused`, `Debugger.resumed`, `Debugger.scriptParsed`, `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Network.*`, `Page.*`, `Log.entryAdded`, `Fetch.requestPaused` (for mocking).

## Dependencies

- `@dbg/store` (internal) -- event recording
- `@dbg/types` (internal) -- `DebuggerState`, `CDP_CAPABILITIES`, `DebugExecutor`
- `chrome-remote-interface` (external) -- CDP WebSocket client

## Dependents

- `@dbg/cli` -- creates `CdpClientWrapper` for open/run/reconnect commands

## Testing

```sh
pnpm run build && vitest run
```
