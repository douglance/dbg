---
name: dbg
description: Debug Node.js processes and automate browser pages using the dbg stateless CLI debugger. Use when investigating runtime bugs, inspecting variables and call stacks, analyzing object state, or automating browser testing. Every call is one command in, one response out — built for AI agents and automation.
context: fork
license: MIT
metadata:
  author: douglance
  version: 0.2.0
---

# dbg - Stateless Debugger & Browser Automation

Debug Node.js processes programmatically. Every `dbg` invocation is stateless: one command in, one response out, exit. A background daemon holds the CDP connection between calls.

## When to Use

- User reports a bug or unexpected behavior in Node.js code
- Need to inspect runtime state, variables, or call stacks
- Investigating why code fails at a specific line
- Analyzing object properties or prototype chains
- Diagnosing slow CDP calls or flaky connections
- Need post-hoc analysis of debugger session history
- **Browser debugging**: console errors, network failures, DOM inspection
- **Browser automation**: navigate, click, type, screenshot
- **Performance testing**: network throttling, device emulation, coverage
- **API mocking**: intercept network requests with custom responses

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

### Multi-Session (Frontend + Backend)

```sh
dbg run "node server.ts"               # auto-named s0
dbg open 9222 --type page fe           # named "fe", targets browser tab
dbg @be b server.ts:42                 # breakpoint on backend
dbg @fe navigate "http://localhost:3000/login"
dbg @fe q "SELECT * FROM console WHERE type = 'error'"
dbg @be q "SELECT * FROM vars"
```

### Browser Navigation

```sh
dbg navigate <url>                     # go to URL
dbg navigate reload                    # reload current page
dbg navigate back                      # go back in history
dbg navigate forward                   # go forward in history
```

### Browser Interaction

```sh
dbg click "<selector>"                 # click element by CSS selector
dbg type "<selector>" "<text>"         # type into element
dbg select "<selector>" "<value>"      # select dropdown option
dbg screenshot                         # capture PNG (returns base64)
dbg screenshot /tmp/page.png           # save to file
```

### Browser Query Tables

```sh
dbg q "SELECT method, url, status FROM network WHERE status >= 400"
dbg q "SELECT * FROM dom WHERE selector = 'h1'"
dbg q "SELECT * FROM cookies"
dbg q "SELECT key, value FROM storage WHERE type = 'local'"
dbg q "SELECT * FROM performance"
dbg q "SELECT * FROM console WHERE type = 'error'"
```

### Network Mocking

```sh
dbg mock "/api/users" '{"users":[]}'              # intercept with mock response
dbg mock "/api/data" '{}' --status 500             # mock error response
dbg unmock "/api/users"                            # remove specific mock
dbg unmock                                         # clear all mocks
```

### Device Emulation & Throttling

```sh
dbg emulate iphone-14                  # emulate iPhone 14 (390x844)
dbg emulate ipad                       # emulate iPad (810x1080)
dbg emulate pixel-7                    # emulate Pixel 7
dbg emulate reset                      # reset to default

dbg throttle 3g                        # simulate 3G network
dbg throttle slow-3g                   # simulate slow 3G
dbg throttle offline                   # simulate offline
dbg throttle off                       # disable throttling
```

### Code Coverage

```sh
dbg coverage start                     # begin tracking JS + CSS usage
# ... interact with the page ...
dbg coverage stop
dbg q "SELECT url, used_pct FROM coverage ORDER BY used_pct ASC"
```

### Target Management

```sh
dbg targets 9222                       # list all debuggable tabs
dbg open 9222 --type page              # connect to first page target
dbg open 9222 --target <id>            # connect to specific tab
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
| `timeline` | Unified cross-stream incident timeline (compact by default) |

Event log queries:

```sh
dbg q "SELECT direction, method, latency_ms FROM cdp ORDER BY id DESC LIMIT 20"
dbg q "SELECT method, latency_ms FROM cdp WHERE latency_ms > 100"
dbg q "SELECT ts, event, session_id FROM connections"
dbg q "SELECT ts, stream, severity, method, entity, summary FROM timeline ORDER BY ts DESC LIMIT 120"
dbg q "SELECT ts, stream, severity, method, summary FROM timeline WHERE include = 'errors' ORDER BY ts DESC LIMIT 80"
dbg q "SELECT ts, stream, method, summary FROM timeline WHERE detail = 'full' AND window_ms = 5000 ORDER BY ts DESC LIMIT 200"
```

Event-backed tables (`events`, `cdp`, `connections`, `timeline`) can be queried even when no debug session is active.

### Browser Tables

| Table | Description | Required Filter |
|---|---|---|
| `network` | HTTP requests/responses | — |
| `network_headers` | Request/response headers | `request_id` |
| `network_body` | Response body content | `request_id` |
| `page_events` | Page lifecycle events | — |
| `dom` | DOM elements by selector | `selector` |
| `styles` | Computed CSS styles | `node_id` |
| `performance` | Performance metrics | — |
| `cookies` | Browser cookies | — |
| `storage` | localStorage/sessionStorage | `type` (local/session) |
| `ws_frames` | WebSocket messages | — |
| `coverage` | JS/CSS code coverage | — |

Browser table queries:

```sh
dbg q "SELECT method, url, status, duration_ms FROM network"
dbg q "SELECT name, value FROM network_headers WHERE request_id = '<id>'"
dbg q "SELECT body FROM network_body WHERE request_id = '<id>'"
dbg q "SELECT node_id, tag, text FROM dom WHERE selector = '.error'"
dbg q "SELECT name, value FROM styles WHERE node_id = 42"
dbg q "SELECT name, value FROM cookies WHERE domain LIKE '%example%'"
dbg q "SELECT key, value FROM storage WHERE type = 'local'"
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

## Browser Debug Loop

```sh
# Scenario: Login page is broken
dbg open 9222 --type page
dbg navigate "http://localhost:3000/login"
dbg q "SELECT type, text FROM console WHERE type = 'error' \j"
dbg q "SELECT method, status, url FROM network WHERE status >= 400 \j"
dbg q "SELECT node_id, text FROM dom WHERE selector = '.error-message' \j"
# ... identify and fix the bug in code ...
dbg navigate reload
dbg q "SELECT * FROM console WHERE type = 'error' \j"
dbg screenshot /tmp/login-fixed.png
# Verify: zero errors, page renders correctly
dbg close
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DBG_SOCK` | `/tmp/dbg.sock` | Unix socket path for daemon communication |
| `DBG_EVENTS_DB` | `/tmp/dbg-events.db` | SQLite event store path (set a persistent path to keep history across runs) |

## Postmortem Timeline Workflow

```sh
# Keep one persistent event DB for repeated runs
export DBG_EVENTS_DB="$HOME/.dbg/history.db"

# Run dbg workflows as usual (open/run/navigate/etc.)
# Later, even with no active session:
dbg q "SELECT ts, stream, severity, method, summary FROM timeline ORDER BY ts DESC LIMIT 200"
dbg q "SELECT ts, method, error FROM cdp WHERE error != '' ORDER BY ts DESC LIMIT 100"
```

## Tips

- Every `dbg` call is independent — no session to manage
- Breakpoints persist across `dbg restart`
- Use SQL WHERE clauses to filter large result sets
- `dbg trace` shows CDP latency to diagnose slow operations
- `dbg health` quickly verifies the target is responsive
- `dbg reconnect` recovers from dropped websocket connections
- For browser pages, use `dbg open <port> --type page` to skip Node.js targets
- `dbg targets <port>` lists all available tabs — use `--target <id>` for specific ones
- Network mocks survive page reload (Fetch domain stays enabled)
- Screenshot returns base64 PNG — agents can "see" the page
- Combine DOM queries + screenshots for both structural and visual verification

## Success Criteria

- Root cause identified and documented
- Relevant variables, stack frames, or object state captured
- Fix validated by re-running with breakpoints at the fix point
