---
name: dbg-dev
description: Develop, test, and debug the dbg stateless CLI debugger. Build workflow, architecture, self-debugging patterns, and contributor guidance.
author: douglance
---

# dbg Development

Internal skill for developing dbg itself.

## Build & Test

```sh
pnpm run build         # build all packages (tsc per package)
pnpm test              # build + vitest
pnpm run ci            # full pipeline (lint + typecheck + build + test)
pnpm run lint          # biome lint
pnpm run format:check  # biome format check
```

## Architecture

pnpm monorepo (`pnpm-workspace.yaml`). All packages under `packages/`.

```
@dbg/cli          CLI entry point, daemon, commands
  → @dbg/adapter-cdp   CDP websocket client + target discovery
  → @dbg/adapter-dap   DAP (Debug Adapter Protocol) client + transport
  → @dbg/query         SQL parser, filter engine, table registry
  → @dbg/store         SQLite-backed event store
  → @dbg/tables-core   Virtual tables: frames, vars, scripts, breakpoints, timeline, etc.
  → @dbg/tables-browser  Browser tables: network, dom, cookies, storage, coverage, etc.
  → @dbg/tables-native   Native debug tables: threads, registers, memory, disassembly, etc.
  → @dbg/types         Shared types (Session, Command, Response, protocol)
```

### Request flow

```
CLI (packages/cli/src/cli.ts)
  → Unix socket → daemon (packages/cli/src/daemon.ts)
    → CDP client (packages/adapter-cdp/src/client.ts) → Chrome DevTools Protocol target
    or → DAP client (packages/adapter-dap/src/client.ts) → Debug Adapter Protocol target
```

## Key Files

| Package | Key Files | Purpose |
|---|---|---|
| `@dbg/cli` | `src/cli.ts` | CLI entry, argv parsing, daemon communication |
| | `src/daemon.ts` | Long-running process, session registry, protocol dispatch |
| | `src/commands.ts` | Command implementations (breakpoints, stepping, eval) |
| | `src/format.ts` | TSV/JSON output formatting |
| | `src/process.ts` | Managed child process spawning |
| `@dbg/adapter-cdp` | `src/client.ts` | CDP websocket client, method dispatch |
| | `src/discovery.ts` | Target discovery via `/json` endpoint |
| `@dbg/adapter-dap` | `src/client.ts` | DAP client |
| | `src/transport.ts` | DAP stream transport |
| | `src/launch.ts` | DAP launch/attach configuration |
| `@dbg/query` | `src/parser.ts` | SQL parser |
| | `src/engine.ts` | Query execution engine |
| | `src/filter.ts` | WHERE clause evaluation |
| | `src/registry.ts` | Virtual table registry |
| `@dbg/store` | `src/index.ts` | SQLite event store (CDP messages, connections) |
| `@dbg/types` | `src/index.ts` | Shared types: Session, Command, Response, SOCKET_PATH |

## Environment Variables

| Variable | Default | Dev Notes |
|---|---|---|
| `DBG_SOCK` | `/tmp/dbg.sock` | Tests use `/tmp/dbg-test.sock` for isolation |
| `DBG_EVENTS_DB` | `/tmp/dbg-events.db` | Tests use per-test temp paths |

## Test Isolation

Tests use isolated socket and database paths to avoid interfering with production daemons:

- Integration tests set `SOCKET_PATH = "/tmp/dbg-test.sock"` and pass `DBG_SOCK` in all env objects
- Each test file uses its own `DBG_EVENTS_DB` path and cleans up after each test
- Never rely on default socket paths in tests
- `fileParallelism: false` in vitest config — tests share sockets and can't run in parallel
- Test fixtures in `test/fixtures/*.js` must preserve exact whitespace (line-number-dependent tests)
- Don't run biome on `test/fixtures/*.js` — it would break line numbers

## Self-Debugging

dbg can debug its own daemon by running a second instance on a different socket.

### Basic Pattern

```sh
# Terminal 1: Start the daemon you want to debug
DBG_SOCK=/tmp/dbg2.sock DBG_EVENTS_DB=/tmp/dbg2-events.db \
  node --inspect-brk=9230 packages/cli/dist/daemon.js

# Terminal 2: Use normal dbg to attach to it
dbg open 9230
dbg b daemon.ts:150
dbg c
dbg q "SELECT * FROM vars"    # see the target daemon's own variables
dbg q "SELECT * FROM frames"  # see its call stack
```

### `--inspect` vs `--inspect-brk`

- **`--inspect-brk`**: Pauses on first line. Good for debugging startup. But the daemon can't serve its socket until you resume it — bootstrap problem.
- **`--inspect`**: Starts normally with debug port open. Daemon is functional immediately. Use breakpoints to catch specific execution points.

For daemon debugging, prefer `--inspect-brk` when investigating startup/initialization, and `--inspect` when debugging request handling.

### Ouroboros Pattern

Two daemons debugging each other — proven working for testing debugger protocol handling:

```sh
# Daemon A on socket A, debug port 9230
DBG_SOCK=/tmp/dbg-a.sock DBG_EVENTS_DB=/tmp/dbg-a-events.db \
  node --inspect=9230 packages/cli/dist/daemon.js

# Daemon B on socket B, debug port 9231
DBG_SOCK=/tmp/dbg-b.sock DBG_EVENTS_DB=/tmp/dbg-b-events.db \
  node --inspect=9231 packages/cli/dist/daemon.js

# A debugs B
DBG_SOCK=/tmp/dbg-a.sock dbg open 9231

# B debugs A
DBG_SOCK=/tmp/dbg-b.sock dbg open 9230

# Now each can pause, step, and inspect the other
DBG_SOCK=/tmp/dbg-a.sock dbg pause     # A pauses B
DBG_SOCK=/tmp/dbg-a.sock dbg e "process.env.DBG_SOCK"  # → /tmp/dbg-b.sock
```

**Deadlock avoidance**: Don't pause both daemons simultaneously. If A is paused and B sends a CDP message requiring A to respond, B hangs. Keep at least one daemon running.

### Eval Scope Gotcha

`dbg e` evaluates in the **current call frame**, not module scope:

- Paused in your code → local variables visible
- Paused in Node internals (e.g., `processTimers` after `pause`) → module-level variables not accessible
- **Fix**: Set a breakpoint in your actual code, continue to it, then evaluate

```sh
# Wrong: paused in Node internals
dbg e "myConfig"  # → ReferenceError

# Right: continue to your code first
dbg b daemon.ts:25
dbg c
dbg e "myConfig"  # → { port: 9222, ... }
```
