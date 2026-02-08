```
     ██████╗ ██████╗  ██████╗
     ██╔══██╗██╔══██╗██╔════╝
     ██║  ██║██████╔╝██║  ███╗
     ██║  ██║██╔══██╗██║   ██║
     ██████╔╝██████╔╝╚██████╔╝
     ╚═════╝ ╚═════╝  ╚═════╝
     Node.js debugger built for automation
```

# dbg

A stateless, non-interactive Node.js debugger designed for programmatic use. Every invocation is one command in, one response out, exit. No REPL. No human in the loop.

Built for AI coding agents, CI pipelines, scripts, and any workflow where a debugger needs to be driven by another program rather than a person typing into a prompt.

## Why

Traditional debuggers are interactive. They assume a human is sitting at a terminal, navigating menus, remembering state. That model breaks completely when the caller is a program.

**dbg** treats debugging as an API:

- **Stateless CLI** — every call is independent. No session to manage.
- **Machine-readable output** — TSV by default, JSON with `\j`. No color, no decoration, no unicode.
- **SQL query engine** — `SELECT name, value FROM vars WHERE frame_id = 0`. Sixteen virtual tables expose everything the debugger can see.
- **Event store** — every CDP message, connection event, and daemon lifecycle action is logged to SQLite for post-hoc analysis.
- **Background daemon** — a thin daemon holds the CDP connection between calls. The CLI is just a client.
- **Exit codes** — 0 or 1. Parse stdout, check the code, move on.

## Install

```sh
npm install -g @douglance/dbg
```

### As a Claude Code Skill

Install the [Agent Skill](https://agentskills.io) to give Claude Code the ability to debug Node.js processes:

```sh
npx skills add douglance/dbg
```

This adds the `dbg` skill so Claude can autonomously attach to processes, set breakpoints, inspect variables, and query runtime state via SQL.

## Quick Start

Attach to a running process:

```sh
node --inspect-brk app.ts &
dbg open 9229
dbg status                    # connected  paused  app.ts:1  (anonymous)
dbg b app.ts:42
dbg c                         # paused  app.ts  42  handleRequest
dbg q "SELECT name, value FROM vars WHERE frame_id = 0"
dbg close
```

Or let dbg manage the process:

```sh
dbg run "node server.ts"
dbg b routes.ts:15
dbg c
dbg e "req.body"
dbg restart                   # breakpoints survive
dbg close
```

## Commands

### Lifecycle

| Command | Description |
|---|---|
| `dbg open <port\|host:port>` | Attach to a process with `--inspect` enabled |
| `dbg close` | Disconnect (kills target if started via `run`) |
| `dbg run "<command>"` | Spawn with `--inspect-brk`, connect automatically |
| `dbg restart` | Kill, respawn, reconnect, restore all breakpoints |
| `dbg status` | Connection state, pause state, location, PID |

### Flow Control

| Command | Description |
|---|---|
| `dbg c` | Continue. Blocks until next pause. |
| `dbg s` | Step into |
| `dbg n` | Step over |
| `dbg o` | Step out |
| `dbg pause` | Pause execution |

All flow commands output a single line:

```
paused	app.ts	42	handleRequest
```

Or `running` if no breakpoint was hit.

### Breakpoints

```sh
dbg b app.ts:42               # set
dbg b app.ts:42 if x > 0      # conditional
dbg db <id>                   # delete
dbg bl                        # list all
```

Breakpoints persist across `dbg restart`.

### Inspection

```sh
dbg e "req.headers"           # evaluate expression, bare value output
dbg src                       # source around current location
dbg src app.ts 10 20          # specific line range
```

### Diagnostics

```sh
dbg trace                     # show recent CDP send/recv history
dbg trace 50                  # limit to 50 messages
dbg health                    # probe Runtime.evaluate("1+1"), report latency
dbg reconnect                 # reconnect to last known websocket URL
```

| Command | Description |
|---|---|
| `dbg trace [limit]` | Show recent CDP message history with direction and latency |
| `dbg health` | Evaluate `1+1` on target, report latency in ms |
| `dbg reconnect` | Reconnect to the last websocket URL from a previous session |

### Query Engine

Everything the debugger can see is queryable with SQL:

```sh
dbg q "SELECT * FROM frames"
dbg q "SELECT name, value FROM vars WHERE frame_id = 0"
dbg q "SELECT * FROM scripts WHERE file LIKE '%router%'"
dbg q "SELECT name, value FROM props WHERE object_id = '1234'"
```

Syntax: `SELECT [cols | *] FROM table [WHERE ...] [ORDER BY col [ASC|DESC]] [LIMIT n]`

WHERE supports: `=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `AND`, `OR`, parentheses.

#### Virtual Tables

##### Debugger State

| Table | Description | Key Columns |
|---|---|---|
| `frames` | Call stack | `id`, `function`, `file`, `line` |
| `scopes` | Scope chains | `frame_id`, `type`, `name`, `object_id` |
| `vars` | Variables (frame 0, skips global) | `name`, `type`, `value`, `object_id` |
| `this` | `this` binding per frame | `frame_id`, `type`, `value` |
| `props` | Object properties | `name`, `type`, `value`, `child_id` |
| `proto` | Prototype chain | `depth`, `type`, `value` |
| `breakpoints` | All breakpoints | `id`, `file`, `line`, `condition`, `hits` |
| `scripts` | Loaded scripts | `id`, `file`, `url`, `lines` |
| `source` | Source lines (lazy) | `line`, `text` |
| `console` | Console messages | `type`, `text`, `ts` |
| `exceptions` | Thrown exceptions | `text`, `file`, `line`, `uncaught` |
| `async_frames` | Async stack traces | `function`, `file`, `line` |
| `listeners` | Event listeners | `type`, `handler`, `once` |

##### Event Log

| Table | Description | Key Columns |
|---|---|---|
| `events` | Raw event log (daemon, CDP, connections) | `id`, `ts`, `source`, `category`, `method`, `data`, `session_id` |
| `cdp` | CDP messages with latency metrics | `id`, `ts`, `direction`, `method`, `latency_ms`, `error`, `data` |
| `cdp_messages` | Alias of `cdp` | Same as `cdp` |
| `connections` | Connection lifecycle events | `id`, `ts`, `event`, `session_id`, `data` |

Tables marked with required filters (`props`, `proto`, `source`, `listeners`) will tell you what they need.

#### Object Drill-Down

```sh
# Get the object_id
dbg q "SELECT name, object_id FROM vars WHERE name = 'config'"
# name    object_id
# config  1234

# Inspect its properties
dbg q "SELECT name, type, value FROM props WHERE object_id = '1234'"
# name    type     value
# port    number   3000
# debug   boolean  true
# nested  object   [Object]

# Keep going
dbg q "SELECT name, value FROM props WHERE object_id = '5678'"
```

#### Event Log Queries

```sh
# Recent CDP traffic
dbg q "SELECT direction, method, latency_ms FROM cdp ORDER BY id DESC LIMIT 20"

# Slow CDP calls
dbg q "SELECT method, latency_ms FROM cdp WHERE latency_ms > 100"

# Connection history
dbg q "SELECT ts, event, session_id FROM connections"

# All events for current session
dbg q "SELECT ts, source, method FROM events WHERE category = 'cdp' ORDER BY id DESC LIMIT 50"
```

## Event Store

All debugger activity is recorded to a SQLite database for post-hoc analysis and diagnostics.

- **Location**: `/tmp/dbg-events.db` (override with `DBG_EVENTS_DB` env var)
- **Format**: SQLite with WAL mode, async batched writes (~100ms flush interval)
- **Categories**: `daemon` (lifecycle), `connection` (connect/disconnect/reconnect), `cdp` (protocol messages)
- **Session tracking**: Each connection gets a unique session ID for correlation

The event store powers the `events`, `cdp`/`cdp_messages`, and `connections` virtual tables, as well as the `dbg trace` command. You can also query the database directly with any SQLite client.

## Output Format

- **TSV** for tabular data. Header row, tab-delimited.
- **Bare values** for eval. Single line.
- **Single status line** for flow commands.
- **JSON** mode: append `\j` to any query — `dbg q "SELECT * FROM frames\j"`
- **stdout** for data, **stderr** for errors.
- **Exit 0** on success, **1** on error.

No color. No decoration. Designed to be parsed.

## Architecture

```
caller        CLI              daemon            target
  │            │                  │                 │
  ├─ dbg n ──► │                  │                 │
  │            ├─ JSON/socket ──► │                 │
  │            │                  ├─ CDP/WS ──────► │
  │            │                  │◄── Debugger.paused
  │            │◄── JSON/socket ──┤                 │
  │◄─ stdout ──┤                  │                 │
  │            exit               │                 │
```

The CLI is a thin client. It connects to a background daemon over a Unix socket (`/tmp/dbg.sock`), sends one command, receives one response, prints it, and exits. The daemon holds the persistent Chrome DevTools Protocol connection to the target.

The daemon also maintains an **event store** (SQLite) that records every CDP message, connection event, and lifecycle action. This enables the `trace`, `health`, and event log query tables without adding state to the CLI.

## Compatibility

Works with any target that speaks the V8 Inspector Protocol:

- Node.js (`--inspect` / `--inspect-brk`)
- Deno (`--inspect`)
- Any V8-based runtime with an inspector

Domain enabling is timeout-resilient — targets that don't implement all CDP domains (like embedded V8 runtimes) connect gracefully with reduced functionality.

## License

MIT
