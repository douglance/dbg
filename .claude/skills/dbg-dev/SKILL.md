---
name: dbg-dev
description: Develop, test, and debug the dbg stateless CLI debugger. Build workflow, architecture, self-debugging patterns, and contributor guidance.
author: douglance
---

# dbg Development

Internal skill for developing dbg itself.

## Build & Test

```sh
npm run build          # tsup bundler
npm test               # vitest
npm run ci             # full pipeline (lint + typecheck + build + test)
npx biome check src/   # lint/format check
```

## Architecture

```
CLI (src/cli.ts)
  → daemon (src/daemon.ts)
    → CDP client (src/cdp/client.ts)
      → Chrome DevTools Protocol target
```

- **Protocol**: `src/protocol.ts` — message types between CLI and daemon
- **Query engine**: `src/query/` — SQL parser, virtual tables, formatters
- **Event store**: `src/store.ts` — SQLite-backed event log (CDP messages, connections, timeline)
- **CDP discovery**: `src/cdp/discovery.ts` — target enumeration and websocket URL resolution

## Key Files

| File | Purpose |
|---|---|
| `src/cli.ts` | CLI entry point, argument parsing, daemon communication |
| `src/daemon.ts` | Long-running process, holds CDP connection, handles protocol messages |
| `src/cdp/client.ts` | CDP websocket client, method dispatch, event handling |
| `src/cdp/discovery.ts` | Target discovery via `/json` endpoint |
| `src/protocol.ts` | CLI↔daemon message types and socket protocol |
| `src/query/` | SQL query engine — parser, planner, virtual table implementations |
| `src/store.ts` | SQLite event store for CDP messages and connection events |
| `src/commands.ts` | Command implementations (breakpoints, stepping, eval, etc.) |

## Environment Variables

| Variable | Default | Dev Notes |
|---|---|---|
| `DBG_SOCK` | `/tmp/dbg.sock` | Tests use `/tmp/dbg-test.sock` for isolation |
| `DBG_EVENTS_DB` | `/tmp/dbg-events.db` | Tests use `/tmp/dbg-test-events.db` |

## Test Isolation

Tests use isolated socket and database paths to avoid interfering with production daemons:

```sh
# Test helpers automatically set these:
DBG_SOCK=/tmp/dbg-test.sock
DBG_EVENTS_DB=/tmp/dbg-test-events.db
```

All test helpers in `test/helpers.ts` pass `DBG_SOCK` and `DBG_EVENTS_DB` via env to spawned processes. Never rely on the default paths in tests.

## Self-Debugging

dbg can debug its own daemon by running a second instance on a different socket.

### Basic Pattern

```sh
# Terminal 1: Start the daemon you want to debug
DBG_SOCK=/tmp/dbg2.sock DBG_EVENTS_DB=/tmp/dbg2-events.db \
  node --inspect-brk=9230 dist/daemon.js

# Terminal 2: Use normal dbg to attach to it
dbg open 9230
dbg b daemon.ts:150
dbg c
dbg q "SELECT * FROM vars"    # see the target daemon's own variables
dbg q "SELECT * FROM frames"  # see its call stack
```

### `--inspect` vs `--inspect-brk`

- **`--inspect-brk`**: Pauses on first line. Gives you time to attach and set breakpoints before any code runs. But the daemon can't serve requests until you resume it — bootstrap problem if you need the daemon running to debug it.
- **`--inspect`**: Starts normally, debugger attaches when ready. The daemon is functional immediately but you may miss early initialization code. Use breakpoints to catch specific execution points.

For daemon debugging, prefer `--inspect-brk` when investigating startup/initialization, and `--inspect` when debugging request handling.

### Ouroboros Pattern

Two daemons debugging each other — useful for testing the debugger's own debugger protocol handling:

```sh
# Daemon A: the "subject" — the one being debugged
DBG_SOCK=/tmp/dbg-a.sock DBG_EVENTS_DB=/tmp/dbg-a-events.db \
  node --inspect=9230 dist/daemon.js

# Daemon B: the "observer" — a second dbg instance that debugs A
DBG_SOCK=/tmp/dbg-b.sock DBG_EVENTS_DB=/tmp/dbg-b-events.db \
  node --inspect=9231 dist/daemon.js

# Use CLI to tell B to attach to A
DBG_SOCK=/tmp/dbg-b.sock dbg open 9230

# Now you can also debug B from a third instance, or from the default daemon
dbg open 9231
```

**Deadlock avoidance**: If daemon A is paused at a breakpoint and daemon B sends a CDP message that requires A to respond, B will hang waiting. Always keep at least one daemon running freely. Don't pause both simultaneously unless you understand the message flow.

### Eval Scope Gotcha

`dbg e "<expression>"` evaluates in the **current call frame**, not module scope. This matters when paused:

- If paused inside a function in your code → you can see that function's local variables
- If paused in Node.js internals (e.g., after `--inspect-brk` before any user code runs) → you're in Node's bootstrap frame, not your module. Module-level variables like imports and `const` declarations are **not visible**
- **Fix**: Set a breakpoint in your actual code (`dbg b yourfile.ts:10`), continue to it (`dbg c`), then evaluate. The call frame determines what's in scope.

```sh
# Wrong: paused in Node internals after --inspect-brk
dbg e "myConfig"  # → ReferenceError: myConfig is not defined

# Right: continue to your code first
dbg b daemon.ts:25
dbg c
dbg e "myConfig"  # → { port: 9222, ... }
```
