---
name: dbg
description: Debug Node.js processes using the dbg stateless CLI debugger. Use when investigating runtime bugs, inspecting variables and call stacks, or analyzing object state. Every call is one command in, one response out — built for AI agents and automation.
context: fork
license: MIT
metadata:
  author: douglance
  version: 0.2.0
---

# dbg - Stateless Node.js Debugger

Debug Node.js processes programmatically. Every `dbg` invocation is stateless: one command in, one response out, exit. A background daemon holds the CDP connection between calls.

## When to Use

- User reports a bug or unexpected behavior in Node.js code
- Need to inspect runtime state, variables, or call stacks
- Investigating why code fails at a specific line
- Analyzing object properties or prototype chains
- Diagnosing slow CDP calls or flaky connections
- Need post-hoc analysis of debugger session history

## Commands

### Start a Session

```sh
dbg open <port|host:port>       # attach to --inspect process
dbg run "node <file>"           # spawn with --inspect-brk, connect
```

### Set Breakpoints

```sh
dbg b <file>:<line>             # set breakpoint
dbg b <file>:<line> if <cond>   # conditional breakpoint
dbg bl                          # list all breakpoints
dbg db <id>                     # delete breakpoint
```

### Control Execution

```sh
dbg c                           # continue (blocks until next pause)
dbg n                           # step over
dbg s                           # step into
dbg o                           # step out
dbg pause                       # pause execution
dbg status                      # check connection/pause state
```

### Inspect State (SQL)

```sh
dbg q "SELECT * FROM frames"
dbg q "SELECT name, type, value FROM vars WHERE frame_id = 0"
dbg q "SELECT * FROM scripts WHERE file LIKE '%<pattern>%'"
dbg q "SELECT name, value FROM props WHERE object_id = '<id>'"
dbg q "SELECT * FROM console"
dbg q "SELECT * FROM exceptions"
```

SQL syntax: `SELECT [cols | *] FROM <table> [WHERE ...] [ORDER BY col [ASC|DESC]] [LIMIT n]`

WHERE operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `AND`, `OR`, `()`

### Evaluate and View Source

```sh
dbg e "<expression>"            # evaluate, bare value output
dbg src                         # source around current location
dbg src <file> <start> <end>    # specific line range
```

### Diagnostics

```sh
dbg trace                       # recent CDP send/recv with latency
dbg trace 50                    # limit to 50 messages
dbg health                      # probe target, report latency (ms)
dbg reconnect                   # reconnect to last websocket URL
```

### Session Lifecycle

```sh
dbg restart                     # respawn, reconnect, restore breakpoints
dbg close                       # disconnect (kills target if started via run)
```

## Virtual Tables

### Debugger State

| Table | Description | Required Filter |
|---|---|---|
| `frames` | Call stack | — |
| `scopes` | Scope chains | — |
| `vars` | Variables (frame 0, skips global) | — |
| `this` | `this` binding per frame | — |
| `props` | Object properties | `object_id` |
| `proto` | Prototype chain | `object_id` |
| `breakpoints` | All breakpoints | — |
| `scripts` | Loaded scripts | — |
| `source` | Source lines | `file` or `script_id` |
| `console` | Console messages | — |
| `exceptions` | Thrown exceptions | — |
| `async_frames` | Async stack traces | — |
| `listeners` | Event listeners | `object_id` |

### Event Log

| Table | Description |
|---|---|
| `events` | Raw event log (daemon, CDP, connections) |
| `cdp` / `cdp_messages` | CDP messages with direction and latency |
| `connections` | Connection lifecycle (connect, disconnect, reconnect) |

Event log queries:

```sh
dbg q "SELECT direction, method, latency_ms FROM cdp ORDER BY id DESC LIMIT 20"
dbg q "SELECT method, latency_ms FROM cdp WHERE latency_ms > 100"
dbg q "SELECT ts, event, session_id FROM connections"
```

## Output Format

- **TSV** by default (tab-separated, header row)
- **JSON**: append `\j` — `dbg q "SELECT * FROM frames\j"`
- **Bare values** for `dbg e` output
- **Single status line** for flow commands
- **Exit 0** success, **1** error. Parse stdout, check exit code.

## Object Drill-Down Pattern

```sh
# 1. Get object_id from variables
dbg q "SELECT name, object_id FROM vars WHERE name = 'config'"

# 2. Inspect its properties
dbg q "SELECT name, type, value FROM props WHERE object_id = '<id>'"

# 3. Keep drilling into nested objects
dbg q "SELECT name, value FROM props WHERE object_id = '<child_id>'"
```

## Example Workflow

```sh
# Scenario: Function returns unexpected value
dbg run "node app.ts"
dbg b app.ts:42
dbg c
dbg q "SELECT name, type, value FROM vars WHERE frame_id = 0"
dbg e "config.settings"
dbg q "SELECT id, function, file, line FROM frames LIMIT 5"
dbg n
dbg q "SELECT name, value FROM vars WHERE name = 'result'"
dbg close
```

## Tips

- Every `dbg` call is independent — no session to manage
- Breakpoints persist across `dbg restart`
- Use SQL WHERE clauses to filter large result sets
- `dbg trace` shows CDP latency to diagnose slow operations
- `dbg health` quickly verifies the target is responsive
- `dbg reconnect` recovers from dropped websocket connections
- All events are logged to SQLite (`/tmp/dbg-events.db`) for post-hoc analysis

## Success Criteria

- Root cause identified and documented
- Relevant variables, stack frames, or object state captured
- Fix validated by re-running with breakpoints at the fix point
