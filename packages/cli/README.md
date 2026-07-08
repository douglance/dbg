# @dbg/cli

CLI entry point, background daemon, and command handlers for dbg. This is the main package that wires everything together.

## Architecture

```
CLI (cli.ts) --Unix socket--> Daemon (daemon.ts) --CDP/DAP--> Target
```

- **CLI** (`cli.ts`): Parses argv, auto-starts daemon, sends one JSON command over `/tmp/dbg.sock`, prints response, exits.
- **Daemon** (`daemon.ts`): Long-running background process. Holds session registry, CDP/DAP connections, event store, and table registry.
- **Commands** (`commands.ts`): Stateless command handlers (status, flow control, breakpoints, eval, source, trace, health, reconnect).
- **Attach Strategy** (`attach-strategy.ts`): Multi-strategy attach logic for Apple devices (device-process and gdb-remote fallback).
- **Format** (`format.ts`): TSV, JSON, and human-readable formatters for CLI output.
- **Process** (`process.ts`): Spawn/kill managed Node.js processes with `--inspect-brk`.

## Public API (via index.ts)

- Re-exports from `commands.ts`: `handleStatus`, `handleContinue`, `handleStepInto`, `handleStepOver`, `handleStepOut`, `handlePause`, `handleSetBreakpoint`, `handleDeleteBreakpoint`, `handleListBreakpoints`, `handleEval`, `handleSource`, `handleTrace`, `handleHealth`, `handleReconnect`.
- Re-exports from `format.ts`: `formatTsv`, `formatJson`, `formatFlowStatus`, `formatStatus`, `formatBreakpointSet`, `formatBreakpointList`, `formatSource`.
- Re-exports from `process.ts`: `spawnTarget`, `killTarget`.

## Session Management

The daemon maintains a `Map<string, Session>` registry:
- `resolveSession(name?)`: Explicit name > single session auto-resolve > current pointer > null.
- `@name` prefix in CLI targets a session: `dbg @be c`.
- `ss` lists sessions, `use` switches current.

## Dependencies

- `@dbg/adapter-cdp` (internal) -- CDP client + discovery
- `@dbg/adapter-dap` (internal) -- DAP client
- `@dbg/provider-apple-device` (internal) -- Apple device attach resolution
- `@dbg/query` (internal) -- SQL query engine
- `@dbg/store` (internal) -- SQLite event store
- `@dbg/tables-browser` (internal) -- browser virtual tables
- `@dbg/tables-core` (internal) -- core virtual tables
- `@dbg/tables-native` (internal) -- native virtual tables
- `@dbg/types` (internal) -- shared types

## Dependents

- `@douglance/dbg` (npm package) -- bundles this into a single distributable

## Testing

```sh
pnpm run build && vitest run
```
