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
- **Machine-readable output** — TOON (compact, token-efficient) by default, JSON with `--json`. No color, no decoration, no unicode.
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
dbg status                    # ok: true, connected: true, status: paused, file: app.ts, line: 1
dbg b app.ts:42
dbg c                         # ok: true, status: paused, file: app.ts, line: 42, function: handleRequest
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

## Apple Devices and Simulators (iOS/tvOS/watchOS/visionOS)

`dbg` can also attach to Apple apps via LLDB DAP (no UI, agent-friendly).

Requirements:

- macOS (Apple provider requires `xcrun`)
- Xcode Command Line Tools installed (`xcrun`, `lldb-dap`, `devicectl`, `simctl`)

List available targets:

```sh
dbg devices
dbg devices --platform ios
```

List installed apps on a device:

```sh
dbg apps <device-id>
```

Attach to a running app by bundle id:

```sh
dbg attach com.example.myapp
```

If both a booted simulator and a booted physical device match, `dbg attach` now fails fast with an ambiguity error and asks you to choose `--device` explicitly.

Launch (if not running) then attach:

```sh
dbg attach com.example.myapp --launch
```

On physical devices, if attach fails without `--launch`, dbg automatically retries with `--launch` for a debuggable session. After a `--launch` attach, dbg auto-continues past dyld into app code (lands at `main`).

Force simulator vs physical device:

```sh
dbg attach com.example.myapp --device sim:"iPhone 15" --launch
dbg attach com.example.myapp --device device:<udid-or-name> --launch
```

Tuning:

```sh
dbg attach com.example.myapp --attach-timeout 60 --verbose-attach
dbg attach com.example.myapp --attach-strategy device-process
dbg attach com.example.myapp --attach-strategy gdb-remote
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
| `dbg devices` | List Apple devices and simulators |
| `dbg apps <device-id>` | List installed apps on a device |

### Flow Control

| Command | Description |
|---|---|
| `dbg c` | Continue. Blocks until next pause. |
| `dbg s` | Step into |
| `dbg n` | Step over |
| `dbg o` | Step out |
| `dbg pause` | Pause execution |

All flow commands output a structured result:

```
ok: true
status: paused
file: app.ts
line: 42
function: handleRequest
```

Or `status: running` if no breakpoint was hit. Pass `--json` to receive the
same payload as JSON.

### Breakpoints

```sh
dbg b app.ts:42               # set
dbg b app.ts:42 --if "x > 0"  # conditional
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

### Visual Flight Recorder

Record what the UI looks like over time — headless, in the background — and get
before/after verdicts with component blame. Built for the agent loop
**record → edit → after**:

```sh
dbg record http://localhost:3000    # daemon launches managed headless Chrome, keeps recording
dbg mark before-fix                 # stamp a named epoch (auto-epochs from edit bursts)
# ... edit code; saved files + vite HMR modules annotate captures ...
dbg after --json                    # capture now, diff vs anchor
dbg after --open                    # same, and open the HTML report for humans
dbg timeline                        # filmstrip HTML of the whole recording
dbg replay <captureId>              # restore a capture's URL/scroll
dbg record --status | --stop
```

| Command | Description |
|---|---|
| `dbg record <url>` | Start recording (`--viewport WxH\|desktop\|tablet\|mobile`, `--idle <ms>`, `--max-frames <n>`, `--max-bytes <n>`, `--events-ttl <ms>`) |
| `dbg mark [name]` | Stamp a named epoch in the timeline |
| `dbg after [name]` | Capture + diff vs anchor: `--at capture:<id>\|mark:<name>\|time:<ts\|10m>\|file:<path>`, `--open` |
| `dbg timeline` | Self-contained filmstrip HTML of the most recent frames (`--open`, `--limit <n>`, default 100) |
| `dbg replay <id>` | Restore a capture's URL/scroll in the recorder page |
| `dbg why [substring]` | Blame the most recent (or matched) error → ranked edit/epoch/commit/prompt + one-line answer |
| `dbg shoot <target>` | One-off capture: URL or `Component.tsx` (`--selector`, `--states hover,focus`, `--props <json>`, `--viewport`, `--full-page`, `--out <dir>`, `--name`) |

`dbg after` returns one JSON verdict: pixel diff (`pair.diffPercent`), changed
regions blamed to **React component names** (`regions`, with `causal: true` when
that component's file was just saved/HMR'd; tag.class labels on non-React
pages), computed-style deltas (`styleChanges`), and new console/exception/
network failures since the anchor — plus a self-contained `report.html`
(side-by-side, wipe slider, onion skin, diff overlay with labeled regions).

**Verdicts (Plan V).** `dbg after` also returns `networkDiff` (requests grouped
by method + normalized URL pattern → added/removed/status-changed/duration-delta),
`stateChanges` (added/removed/changed local & sessionStorage keys, from the
per-capture `state_snapshots`), and `a11yNew` (accessibility issues new since the
anchor: missing alt, control/button without name, control without label,
duplicate landmark, missing title). `dbg why [substring]` walks the unified
timeline back from an error to ranked causes — the recent edits (weighted by
recency + whether their file is in the stack trace), the enclosing epoch, the
nearest commit, and the active agent prompt — and phrases a one-line `answer`
like *"…2.1s after you saved src/Cart.tsx (epoch 4: 'before-fix', prompt: 'add
coupon field')"*. Both stay within the sub-second `after` budget (measured
221ms; no budget increase needed).

`dbg shoot Component.tsx` renders the component in an esbuild harness using
*your* project's react-dom and screenshots `#dbg-root`; `--states` forces
`:hover`/`:focus`/etc. via CSS.forcePseudoState — one PNG per state under
`.dbg/shots/` (`name.png`, `name@hover.png`, ...), with reduced motion
emulated for deterministic pixels. For Storybook, shoot the story iframe URL
directly.

Recorder data is queryable like everything else: `captures`, `epochs`, `diffs`,
`regions`, and the first-class `edits` file-edit stream (e.g. `dbg q "SELECT ts,
changed_files, epoch_id FROM captures"`). Every edit, commit, screenshot, and
agent prompt shares one epoch-ms `ts`, so they all join on the unified
`timeline` table — see **Unified Timeline & Dev Tables** below.

**Retention.** History is metadata (cheap, kept forever); pixels decay
(expensive, bounded). PNGs and DOM snapshots are stored content-addressed under
`.dbg/recordings/recorder/blobs/` — identical frames share one blob. Per
recording session, at most 200 full-resolution frames and 100MB of blobs are
kept (`--max-frames`, `--max-bytes`); over budget, the oldest frames decay
first to ≤320px thumbnails, then to metadata-only rows (`captures.tier`:
`full` → `thumb` → `meta`), preferring to keep each epoch's first and last
frames. Never decayed: the newest capture, epoch anchors, and any capture
referenced by a diff. Raw CDP `events` rows are pruned after 30 minutes
(`--events-ttl <ms>`, most-recent 50k rows always kept). `dbg record --status`
reports `diskBytes`, `fullFrames`, `thumbFrames`, `metaFrames`, and
`eventsRows`; `dbg timeline` embeds the most recent 100 frames (`--limit`).

**Performance.** Sub-second after-verdicts are the design target — agents can
poll the loop cheaply. Budgets are enforced in CI (`test/perf.test.ts`):
`record` cold start < 4s (includes Chrome launch), `mark` < 500ms,
`after` < 1.5s, `timeline` < 1s, `shoot` < 5s (throwaway Chrome), DOM
mutation → capture row < 1.5s. Typical measured times are ~3x under budget.

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

The former CDP event-stream `timeline` view is now `events_stream` (schema
unchanged: `stream`, `phase`, `severity`, `entity`, `summary`, plus the
`detail`/`include`/`window_ms` pushdown filters). The `timeline` name now belongs
to the unified cross-source union below.

##### Unified Timeline & Dev Tables

Every development signal lives on one epoch-milliseconds `ts` axis, so file
edits, git commits, screenshots, and agent history join directly:

| Table | Description | Key Columns |
|---|---|---|
| `edits` | First-class file-edit stream (one row per fs-watch event during recording) | `id`, `ts`, `path`, `epoch_id`, `session_id` |
| `state_snapshots` | Per-capture local/sessionStorage dump | `capture_id`, `kind`, `data` |
| `a11y_issues` | Per-capture accessibility issues | `capture_id`, `rule`, `selector`, `detail` |
| `commits` | `git log` of the cwd repo (override `WHERE repo = '/abs'`, 500 most recent) | `hash`, `short_hash`, `ts`, `author`, `summary`, `files` |
| `agent_prompts` | Claude Code prompts, cwd-scoped (`WHERE project = '<slug>'` widens) | `ts`, `display`, `project` |
| `agent_sessions` | Per-session transcript summaries (cached by mtime/size) | `session_id`, `ts_first`, `ts_last`, `title`, `message_count` |
| `timeline` | Union over captures/epochs/edits/console-errors/exceptions/commits/prompts/diffs | `ts`, `kind`, `session_id`, `label`, `ref_id`, `detail` |

`timeline` defaults to the last 24h (unless a `WHERE` constrains `ts`); `kind` is
`capture`/`mark`/`epoch`/`edit`/`error`/`exception`/`commit`/`prompt`/`diff`.
`dbg q` threads your shell cwd so the dev tables scope to your project.

Queries that reference more than one table (or use `JOIN`/`BETWEEN`/`GROUP
BY`/aliases the single-table engine can't parse) are materialized into an
in-memory SQLite DB and run as **real SQL**:

```sh
# Which prompt → edit → error chain (one SELECT across four sources)
dbg q "SELECT p.display, e.path, x.label
       FROM agent_prompts p
       JOIN edits e ON e.ts BETWEEN p.ts AND p.ts + 600000
       JOIN timeline x ON x.kind = 'error' AND x.ts BETWEEN e.ts AND e.ts + 5000
       ORDER BY e.ts"

# Errors within 5s of each edit
dbg q "SELECT e.path, t.label FROM edits e
       JOIN timeline t ON t.kind = 'error' AND t.ts BETWEEN e.ts AND e.ts + 5000"

# Commits with no subsequent capture
dbg q "SELECT c.short_hash, c.summary FROM commits c
       WHERE (SELECT COUNT(*) FROM captures cap WHERE cap.ts > c.ts) = 0"
```

Cold-scan costs: `commits` ~50–150ms (git), `agent_prompts` ~100ms (one JSONL),
`agent_sessions` ~0.7s cold / ~50ms warm (cached), store tables sub-ms. Network
failures are excluded from `timeline` (CDP Network ts is monotonic, not epoch-ms).

#### Object Drill-Down

```sh
# Get the object_id
dbg q "SELECT name, object_id FROM vars WHERE name = 'config'"
# ok: true
# columns[2]: name,object_id
# rows[1]:
#   - [2]: config,1234

# Inspect its properties
dbg q "SELECT name, type, value FROM props WHERE object_id = '1234'"
# ok: true
# columns[3]: name,type,value
# rows[3]:
#   - [3]: port,number,3000
#   - [3]: debug,boolean,true
#   - [3]: nested,object,[Object]

# Keep going (or add --json for easy parsing)
dbg q "SELECT name, value FROM props WHERE object_id = '5678'" --json
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
  - If default paths are unhealthy and no `DBG_SOCK`/`DBG_EVENTS_DB` overrides are set, dbg automatically retries with deterministic per-user/per-repo fallback paths under `/tmp`.
- **Format**: SQLite with WAL mode, async batched writes (~100ms flush interval)
- **Categories**: `daemon` (lifecycle), `connection` (connect/disconnect/reconnect), `cdp` (protocol messages)
- **Session tracking**: Each connection gets a unique session ID for correlation

The event store powers the `events`, `cdp`/`cdp_messages`, and `connections` virtual tables, as well as the `dbg trace` command. You can also query the database directly with any SQLite client.

## Output Format

- **TOON** (compact, token-efficient) by default for every command.
- **JSON** with `--json`, or pick a format explicitly via `--format toon|json|yaml|md|jsonl`.
- **stdout** for data and errors. **Exit 0** on success, **1** on error.

TOON is a YAML-like encoding that is roughly half the tokens of equivalent JSON
while staying trivial for a script to parse. Use `--json` when you want to pipe
output into another tool.

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

The CLI is a thin client. It connects to a background daemon over a Unix socket (default `/tmp/dbg.sock`), sends one command, receives one response, prints it, and exits. If the default socket/db path is unhealthy, it auto-retries with a deterministic per-user/per-repo fallback path (unless `DBG_SOCK`/`DBG_EVENTS_DB` are explicitly set). The daemon holds the persistent Chrome DevTools Protocol connection to the target.

The daemon also maintains an **event store** (SQLite) that records every CDP message, connection event, and lifecycle action. This enables the `trace`, `health`, and event log query tables without adding state to the CLI.

## Compatibility

Works with any target that speaks the V8 Inspector Protocol:

- Node.js (`--inspect` / `--inspect-brk`)
- Deno (`--inspect`)
- Any V8-based runtime with an inspector

And native targets via LLDB DAP:

- iOS, tvOS, watchOS, visionOS apps on physical devices and simulators
- Local native binaries via `dbg attach-lldb`

Domain enabling is timeout-resilient — targets that don't implement all CDP domains (like embedded V8 runtimes) connect gracefully with reduced functionality. Native sessions handle adapter disconnections gracefully (e.g., `registers` on physical devices returns a friendly error instead of crashing the session).

## License

MIT
