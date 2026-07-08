---
name: dbg
description: Debug Node.js processes and automate browser pages using the dbg stateless CLI debugger. Use when investigating runtime bugs, inspecting variables and call stacks, analyzing object state, or automating browser testing. Every call is one command in, one response out — built for AI agents and automation.
context: fork
license: MIT
metadata:
  author: douglance
  version: 0.4.0
---

# dbg - Stateless Debugger & Browser Automation

Debug Node.js processes and native apps programmatically. Every `dbg` invocation is stateless: one command in, one response out, exit. A background daemon holds the CDP/DAP connection between calls.

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
dbg b <file>:<line>                  # set breakpoint
dbg b <file>:<line> --if "<cond>"    # conditional breakpoint
dbg bl                               # list all breakpoints
dbg db <id>                          # delete breakpoint
```

### Taps (Logpoints)

A tap is a never-pausing conditioned breakpoint that logs an expression each
time the line runs — instrument code without editing it or stopping execution.
Works on browser AND node (V8 inspector) sessions.

```sh
dbg tap add src/Cart.tsx:42 "user.id"   # log user.id whenever line 42 runs (1-based)
dbg tap add app.js:3 "doubled" --url "app\\.js"  # --url overrides the file-suffix regex (bundles)
dbg tap list                            # all taps (id, file, line, expr, url_regex)
dbg tap hits <id> --tail 20             # the most-recent values this tap captured
dbg tap rm <id>                         # remove the tap + its CDP breakpoint
dbg q "SELECT ts, value FROM tap_hits WHERE tap_id = <id>"
```

`tap add` echoes the RESOLVED location ("armed on <url>:<line>") or "arms on
script load" when no matching script is loaded yet — never silently pending. The
`__dbg_tap:` console sentinel is routed to `tap_hits` and suppressed from the
user-facing console, `after` consoleDelta, `dbg why`, and the timeline.

### Flows (Record and Replay)

Flows record user actions on the active visual recorder page and replay them
with trusted CDP input, per-step readiness gates, captures, console verdicts,
and diff-vs-last-run data.

```sh
dbg record http://localhost:3000
dbg flow record checkout
dbg flow stop
dbg flow run checkout --step-timeout 5000
dbg flow list
dbg flow show checkout
dbg q "SELECT * FROM flow_run_steps"
```

Selector capture prefers unique `#id`, then `[data-testid]`, then a unique
tag/class selector, then a full `nth-of-type` fallback path.
Scroll-only flows are valid: recording a user scroll or `window.scrollTo(...)`
persists a `scroll` step and replays it against static `file://` reports as
well as app pages.

Use `dbg` for CDP-backed debugger state, flight-recorder verdicts, SQL tables,
and replayable flows. The CLI package installs `@douglance/play` as a normal
dependency, so general Playwright-runner workflows with durable named sessions,
accessibility snapshots, and smart selector helpers are available without
depending on ad hoc global setup.

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
dbg run "node server.ts"                             # auto-named s0
dbg open 9229 be                                     # positional name (backend)
dbg open 9222 fe --type page                        # named "fe", targets browser tab
dbg b server.ts:42 --session be                      # breakpoint on backend
dbg navigate "http://localhost:3000/login" --session fe
dbg q "SELECT * FROM console WHERE type = 'error'" --session fe
dbg q "SELECT * FROM vars" --session be
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

### Visual Flight Recorder (record → edit → after)

```sh
dbg record http://localhost:3000     # daemon launches headless Chrome, keeps recording
dbg record http://localhost:3000 --viewport 1280x720   # WxH or preset (desktop|tablet|mobile)
dbg mark before-fix                  # stamp a named epoch (auto-epochs happen on edit bursts)
# ... edit code; saved files + vite HMR modules annotate captures automatically ...
dbg after --json                     # capture now, diff vs anchor: pixels + component blame
                                     #   + style deltas + new console/network errors + report.html
dbg after --at mark:before-fix       # explicit anchors: capture:<id> | mark:<name> | time:<ts|10m> | file:<path>
dbg after --perf-budget lcp=2500,cls=0.1   # perfDelta (ΔLCP/ΔCLS/bundle); nonzero exit on breach (--skip-perf to omit)
dbg why                              # blame the most recent error → ranked edit/epoch/commit/prompt
dbg why "coupon"                     # blame the most recent error whose text contains "coupon"
dbg timeline                         # filmstrip HTML of every capture with annotations
dbg replay <captureId>               # restore a capture's URL/scroll in the recorder page
dbg record --status                  # captureCount, epochCount, lastCaptureTs
dbg record --stop                    # end recording, kill managed Chrome
```

`dbg after --json` returns `pair` (diffPercent, diffPixels, clusters), `regions`
(diff clusters blamed to React component names, or tag.class on non-React pages;
`causal: true` when the component's file was just edited), `styleChanges`
(computed-style deltas like `padding-top: 8px → 40px`), `consoleDelta` /
`exceptionDelta` / `networkDelta`, and `reportPath` (self-contained HTML with
side-by-side / wipe / onion-skin / diff-overlay views). Add `--open` for humans.

**Verdict sections (Plan V)** — `dbg after` also returns:
- `networkDiff` — requests grouped by method + normalized URL pattern (numeric
  ids / uuids collapsed to `:id`), classified `added` / `removed` /
  `statusChanged` / `durationDelta` (anchor window vs after window).
- `stateChanges` — added/removed/changed local & sessionStorage keys
  (JSON-parsed values), from the per-capture `state_snapshots`.
- `a11yNew` — accessibility issues present in the after capture but not the
  anchor (five rules: missing alt, control/button without name, control without
  label, duplicate landmark, missing document title).
- `perfDelta` (Plan X) — ΔLCP, ΔCLS (new layout shift during flows), new
  longtask count, ΔJSHeap, Δbundle_bytes, and interaction count/max-duration.
  Sourced from a buffered `PerformanceObserver` (LCP/CLS/longtask/paint/event)
  plus a per-capture `Performance.getMetrics` subset (`JSHeapUsedSize`,
  `JSHeapTotalSize`, `Nodes`, `Documents`, `JSEventListeners`, `LayoutCount`,
  `RecalcStyleCount`) and a per-nav Script/Stylesheet `bundle_bytes` total.
  `nav_id` increments per main-frame navigation observed by the daemon; entries
  are stamped with the nav_id current at receipt. The recorder loop is HMR-alive
  (not reload-heavy), so CLS/LCP are per-hard-nav — they reset only on real
  document navigations. Rows land in the `perf_samples` table.

`dbg why [substring]` walks the substrate back from the target error to ranked
causes and returns a `why` verdict + one-line `answer`, e.g. *"'Cannot read x of
undefined' first seen …, 2.1s after you saved src/Cart.tsx (epoch 4:
'before-fix', prompt: 'add coupon field')"*. Ranking = edit recency +
file-in-stack-trace bonus; plus the enclosing epoch, nearest commit, and active
agent prompt. Reads errors from the **persisted** event store, so it works after
`record --stop` (subject to the events TTL).

Each `after` section is individually skippable to stay fast: `--skip-network`,
`--skip-state`, `--skip-a11y`, `--skip-perf` (measured `after` ≈ 220ms with all
on — perfDelta is pure store reads and adds no CDP round-trip to `after`, so no
budget bump was needed; the only cold cost is one `Performance.getMetrics` call
per capture, best-effort and parallel to snapshot work).
`--perf-budget lcp=2500,cls=0.1` fails (nonzero exit) when the after-side delta
breaches a budget (keys: `lcp`, `cls`, `longtask`, `jsheap`, `bundle`).

### Deliberate Captures (shoot)

```sh
dbg shoot http://localhost:3000 --selector "#nav" --states hover,focus
dbg shoot src/Button.tsx --props '{"variant":"primary"}'   # esbuild harness renders
                                     # the component with YOUR react-dom at #dbg-root
dbg shoot http://localhost:3000 --viewport mobile --full-page
dbg shoot http://localhost:3000 --out screenshots/ --name nav-check
```

Viewport presets: `desktop` (1280x800), `tablet` (768x1024), `mobile` (390x844),
or any `WxH`. Each state produces its own PNG under `.dbg/shots/` (base name for
the default state, `name@hover.png` etc. for forced states); shots also land as
`captures` rows under session `shoot`. prefers-reduced-motion is emulated so
animations don't pollute pixels. For Storybook, shoot the story URL directly
(e.g. `dbg shoot 'http://localhost:6006/iframe.html?id=button--primary'`).

### Apple Device / Simulator (iOS, tvOS, watchOS, visionOS)

```sh
dbg devices                            # list all devices + simulators
dbg devices --platform ios             # filter by platform
dbg apps <device-id>                   # list installed apps on a device
dbg attach com.example.myapp           # attach to running app
dbg attach com.example.myapp --launch  # launch app then attach
dbg attach com.example.myapp --device sim:"iPhone 15" --launch
dbg attach com.example.myapp --device device:<udid> --launch
```

On physical devices, if attach fails without `--launch`, dbg automatically retries with `--launch`. After a `--launch` attach, dbg auto-continues past dyld into app code (lands at `main`).

### Native Debug (LLDB Sessions)

```sh
dbg attach-lldb ./a.out                # launch local binary via lldb-dap
dbg registers                          # show CPU registers
dbg memory <addr> <len>                # read process memory
dbg disasm                             # disassemble at current location
dbg disasm <addr>                      # disassemble at specific address
```

Note: `registers` on physical devices returns a friendly error instead of crashing the session if the adapter disconnects.

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
| `events_stream` | CDP event-stream debug view (stream/phase/severity classification, windowing, coalescing) |

Event log queries:

```sh
dbg q "SELECT direction, method, latency_ms FROM cdp ORDER BY id DESC LIMIT 20"
dbg q "SELECT method, latency_ms FROM cdp WHERE latency_ms > 100"
dbg q "SELECT ts, event, session_id FROM connections"
dbg q "SELECT ts, stream, severity, method, entity, summary FROM events_stream ORDER BY ts DESC LIMIT 120"
dbg q "SELECT ts, stream, severity, method, summary FROM events_stream WHERE include = 'errors' ORDER BY ts DESC LIMIT 80"
dbg q "SELECT ts, stream, method, summary FROM events_stream WHERE detail = 'full' AND window_ms = 5000 ORDER BY ts DESC LIMIT 200"
```

> Note: the `timeline` name now refers to the unified cross-source stream (see
> **Unified Timeline** below). The CDP event-stream view was renamed to
> `events_stream`; its schema and behavior are unchanged.

Event-backed tables (`events`, `cdp`, `connections`, `events_stream`, `timeline`) can be queried even when no debug session is active.

#### Native Tables (LLDB/DAP Sessions)

| Table | Description | Required Filter |
|---|---|---|
| `registers` | CPU register values | — |
| `memory` | Process memory bytes | `address`, `length` |
| `disassembly` | Disassembled instructions | `address` |
| `threads` | Active threads | — |
| `modules` | Loaded modules/libraries | — |
| `watchpoints` | Hardware watchpoints | — |
| `signals` | Signal information | — |

## Browser Tables

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

## Recorder & Dev Tables

Every development signal is stored on one **epoch-milliseconds** timeline (UTC
`ts` INTEGER across every table), so screenshots, file edits, git commits, and
agent history all join on `ts` directly.

| Table | Description | Source |
|---|---|---|
| `captures` | Screenshot capture metadata (url, hash, epoch_id, tier) | recorder store |
| `epochs` | Epoch markers (auto on edit bursts, or named via `dbg mark`) | recorder store |
| `diffs` | `dbg after` pixel-diff results | recorder store |
| `regions` | Blamed diff clusters (`diff_id`) | recorder store |
| `edits` | **First-class file-edit stream** — one row per fs-watch event (`ts`, `path`, `epoch_id`, `session_id`), tagged with the current epoch | recorder store |
| `state_snapshots` | Per-capture local/sessionStorage dump (`capture_id`, `kind`, `data` JSON) | recorder store |
| `a11y_issues` | Per-capture accessibility issues (`capture_id`, `rule`, `selector`, `detail`) | recorder store |
| `taps` | Logpoints (`id`, `session_id`, `file`, `line`, `expr`, `url_regex`, `enabled`) | debug store |
| `tap_hits` | Each tap fire (`tap_id`, `ts`, `value`) | debug store |
| `flows` | Recorded user flows (`id`, `ts`, `name`, `url`, `session_id`) | recorder store |
| `flow_steps` | Recorded flow actions (`flow_id`, `idx`, `kind`, `selector`, `fallback_path`, `value`) | recorder store |
| `flow_runs` | Flow replay summaries (`status`, `steps_total`, `steps_passed`) | recorder store |
| `flow_run_steps` | Per-step replay verdicts (`status`, `capture_id`, `error`, `diff_percent`) | recorder store |
| `commits` | `git log` (hash, short_hash, ts, author, summary, files); default repo = cwd, override `WHERE repo = '/abs'` (500 most recent) | git |
| `agent_prompts` | Claude Code prompts (`ts`, `display`, `project`); default-scoped to cwd, `WHERE project = '<slug>'` widens | `~/.claude/history.jsonl` |
| `agent_sessions` | Per-session transcript summaries (`ts_first`, `ts_last`, `title`, `message_count`) | `~/.claude/projects/<slug>` |
| `timeline` | **Unified union** over all of the above | union |

`dbg q` threads your shell's cwd to the daemon, so `commits` / `agent_prompts` /
`agent_sessions` scope to *your* project, not the daemon's.

### Unified Timeline

`timeline` is a single ts-ordered union (columns: `ts`, `kind`, `session_id`,
`label`, `ref_id`, `detail`). `kind` ∈ `capture` (label=url) · `mark`/`epoch` ·
`edit` (label=path) · `error` / `exception` (label=text) · `netfail`
(label=`method url status`) · `commit` (label=summary, ref_id=short_hash) ·
`prompt` (label=first 120 chars) · `diff`. It defaults to the **last 24h**
unless a `WHERE` constrains `ts`.

Multi-table joins, `BETWEEN`, `GROUP BY`, and aliases now run as **real SQL**:
queries that reference more than one table (or that the single-table engine
can't parse) are materialized into an in-memory SQLite DB and executed there.

```sh
# 1. Causal chain — which prompt caused the edit that produced an error
dbg q "SELECT p.display, e.path, c.url, x.label
       FROM agent_prompts p
       JOIN edits e ON e.ts BETWEEN p.ts AND p.ts + 600000
       JOIN captures c ON c.ts BETWEEN e.ts AND e.ts + 30000
       JOIN timeline x ON x.kind = 'error' AND x.ts BETWEEN e.ts AND e.ts + 5000
       ORDER BY e.ts"

# 2. Errors within 5s of each edit
dbg q "SELECT e.path, e.ts, t.label
       FROM edits e
       JOIN timeline t ON t.kind = 'error' AND t.ts BETWEEN e.ts AND e.ts + 5000
       ORDER BY e.ts"

# 3. Commits with no subsequent capture (shipped but never re-recorded)
dbg q "SELECT c.short_hash, c.summary
       FROM commits c
       WHERE (SELECT COUNT(*) FROM captures cap WHERE cap.ts > c.ts) = 0"
```

**Cold-scan costs:** `commits` shells out to `git log` (~50–150ms). `agent_prompts`
reads one JSONL file (~100ms cold). `agent_sessions` scans a project's transcript
dir — ~0.7s cold on a large history, ~50ms warm (results are cached by
path+mtime+size). `edits` / `captures` / `epochs` / `diffs` are indexed store
reads (sub-ms). `dbg timeline` HTML now interleaves commit + prompt chips between
frame cards by `ts`.

> Network failures ride the timeline as the `netfail` kind, reconstructed from
> the raw events table (whose `ts` is wall-clock epoch-ms at receipt — not CDP's
> monotonic `Network.*.timestamp`), so they honor the unified `ts` contract.

## Output Format

- **TOON** (compact, token-efficient) by default for every command
- **JSON**: `dbg q "SELECT * FROM frames" --json` (or `--format json`)
- `--format toon|json|yaml|md|jsonl` picks the encoding explicitly
- Flow commands return a structured object (`status: paused`, `file`, `line`, `function`)
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
dbg q "SELECT type, text FROM console WHERE type = 'error'" --json
dbg q "SELECT method, status, url FROM network WHERE status >= 400" --json
dbg q "SELECT node_id, text FROM dom WHERE selector = '.error-message'" --json
# ... identify and fix the bug in code ...
dbg navigate reload
dbg q "SELECT * FROM console WHERE type = 'error'" --json
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

## Native Device Debug Loop

```sh
# Scenario: Debug an iOS app on a physical device
dbg devices --platform ios
dbg apps <device-id>
dbg attach com.example.myapp               # auto-retries with --launch if needed
# Now paused in app code (main), not dyld
dbg b ViewController.swift:42
dbg c
dbg q "SELECT name, value FROM vars WHERE frame_id = 0"
dbg n
dbg e "self.viewModel.state"
dbg close
```

## Visual Before/After Loop (agents)

The recorder gives every code edit a visual paper trail — no window, no human:

```sh
dbg record http://localhost:3000     # 1. start recording (background, headless)
dbg mark attempt-1                   # 2. stamp where you are
# 3. edit code — file saves and HMR updates annotate captures automatically
dbg after --json                     # 4. verdict: pixel diff % + blamed components
                                     #    + style deltas + new errors, in one JSON
# 5. iterate; when done, show report.html to the human (dbg after --open)
dbg record --stop
```

"Before" always exists retroactively: the anchor defaults to the last capture
at the newest epoch, so you can edit first and ask questions later.

Performance: sub-second after-verdicts are the design target, so poll freely.
CI-enforced budgets (test/perf.test.ts): record cold start < 4s, mark < 500ms,
after < 1.5s, timeline < 1s, shoot < 5s, mutation → capture row < 1.5s.

The `dbg after --json` verdict shape:

```json
{
  "ok": true,
  "pair": { "name": "capture 1 → capture 3", "baseline": {"captureId": 1, "ts": 0},
            "after": {"captureId": 3, "ts": 0}, "diffPercent": 27.8,
            "diffPixels": 133588, "dimensionsChanged": false, "clusters": 2 },
  "regions": [ { "box": {"x": 8, "y": 61, "w": 480, "h": 280},
                 "label": "ColorCard", "component": "ColorCard",
                 "file": null, "causal": true } ],
  "styleChanges": [ { "selector": "div.color-card", "prop": "padding-top",
                      "before": "8px", "after": "40px" } ],
  "consoleDelta": { "new": [ {"type": "error", "text": "boom", "ts": 0} ] },
  "exceptionDelta": { "new": [] },
  "networkDelta": { "failed": [] },
  "reportPath": ".dbg/recordings/report.html"
}
```

Retention: capture history is bounded — metadata rows are kept forever, but
pixels decay oldest-first once past the budgets (200 full frames / 100MB per
session; `--max-frames`, `--max-bytes`). Decayed frames become ≤320px thumbs,
then metadata-only (`captures.tier` = 'full'|'thumb'|'meta'). Epoch anchors,
diff baselines, and the newest capture never decay, so `dbg after` anchors
stay diffable; a decayed `--at` anchor returns an error suggesting the nearest
full capture. Raw CDP `events` rows expire after 30 minutes (most-recent 50k
kept; `--events-ttl`). Check usage with `dbg record --status` (diskBytes,
fullFrames/thumbFrames/metaFrames, eventsRows).

Recorder SQL tables (join them with `console`, `network`, etc.):

```sh
dbg q "SELECT ts, changed_files, hmr_modules, epoch_id FROM captures"  # visual git log
dbg q "SELECT id, ts, name, auto FROM epochs"                          # marks + edit bursts
dbg q "SELECT name, diff_percent, report_path FROM diffs"              # every after verdict
dbg q "SELECT diff_id, component, causal FROM regions"                 # who changed the pixels
```

## Tips

- Every `dbg` call is independent — no session to manage
- Breakpoints persist across `dbg restart`
- Use SQL WHERE clauses to filter large result sets
- `dbg trace` shows CDP/DAP latency to diagnose slow operations
- `dbg health` quickly verifies the target is responsive
- `dbg reconnect` recovers from dropped websocket connections
- For browser pages, use `dbg open <port> --type page` to skip Node.js targets
- `dbg targets <port>` lists all available tabs — use `--target <id>` for specific ones
- Network mocks survive page reload (Fetch domain stays enabled)
- Screenshot returns base64 PNG — agents can "see" the page
- Combine DOM queries + screenshots for both structural and visual verification
- Physical device attach auto-retries with `--launch` if needed
- After `--launch`, dbg auto-continues past dyld to `main`
- `registers` on physical devices fails gracefully (no session crash)

## Success Criteria

- Root cause identified and documented
- Relevant variables, stack frames, or object state captured
- Fix validated by re-running with breakpoints at the fix point
