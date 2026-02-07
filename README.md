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
- **SQL query engine** — `SELECT name, value FROM vars WHERE frame_id = 0`. Thirteen virtual tables expose everything the debugger can see.
- **Background daemon** — a thin daemon holds the CDP connection between calls. The CLI is just a client.
- **Exit codes** — 0 or 1. Parse stdout, check the code, move on.

## Install

```sh
npm install -g dbg
```

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

## Compatibility

Works with any target that speaks the V8 Inspector Protocol:

- Node.js (`--inspect` / `--inspect-brk`)
- Deno (`--inspect`)
- Any V8-based runtime with an inspector

Domain enabling is timeout-resilient — targets that don't implement all CDP domains (like embedded V8 runtimes) connect gracefully with reduced functionality.

## License

MIT
