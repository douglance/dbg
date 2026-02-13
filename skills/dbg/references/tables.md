# Virtual Table Reference

Detailed column schemas for all 28 virtual tables in dbg.

## Debugger State Tables

### frames
Call stack frames from the current pause point.

| Column | Type | Description |
|---|---|---|
| `id` | number | Frame index (0 = top) |
| `function` | string | Function name |
| `file` | string | Source file path |
| `line` | number | Line number |
| `col` | number | Column number |
| `url` | string | Script URL |
| `script_id` | string | V8 script ID |

### scopes
Scope chains attached to each frame.

| Column | Type | Description |
|---|---|---|
| `id` | number | Scope index |
| `frame_id` | number | Parent frame |
| `type` | string | local, closure, global, etc. |
| `name` | string | Scope name (if available) |
| `object_id` | string | Remote object ID for props drill-down |

### vars
Variables from the current scope. Defaults to frame 0, skips global scope.

| Column | Type | Description |
|---|---|---|
| `frame_id` | number | Parent frame |
| `scope` | string | Scope type |
| `name` | string | Variable name |
| `type` | string | JS type (string, number, object, etc.) |
| `value` | string | String representation |
| `object_id` | string | Remote object ID (for objects) |

### this
The `this` binding for each frame.

| Column | Type | Description |
|---|---|---|
| `frame_id` | number | Frame index |
| `type` | string | JS type |
| `value` | string | String representation |
| `object_id` | string | Remote object ID |

### props
Object properties. **Requires** `WHERE object_id = '<id>'`.

| Column | Type | Description |
|---|---|---|
| `name` | string | Property name |
| `type` | string | JS type |
| `value` | string | String representation |
| `child_id` | string | Remote object ID for nested objects |
| `writable` | boolean | Is writable |
| `configurable` | boolean | Is configurable |
| `enumerable` | boolean | Is enumerable |

### proto
Prototype chain. **Requires** `WHERE object_id = '<id>'`.

| Column | Type | Description |
|---|---|---|
| `depth` | number | Chain depth (0 = direct prototype) |
| `type` | string | JS type |
| `value` | string | String representation |
| `object_id` | string | Remote object ID |

### breakpoints
All set breakpoints.

| Column | Type | Description |
|---|---|---|
| `id` | string | Breakpoint ID |
| `file` | string | Source file |
| `line` | number | Line number |
| `condition` | string | Condition expression (if conditional) |
| `hits` | number | Hit count |
| `enabled` | boolean | Is active |

### scripts
All loaded scripts in the target.

| Column | Type | Description |
|---|---|---|
| `id` | string | V8 script ID |
| `file` | string | File path |
| `url` | string | Script URL |
| `lines` | number | Line count |
| `source_map` | string | Source map URL |
| `is_module` | boolean | ES module flag |

### source
Source code lines. **Requires** `WHERE file = '<path>'` or `WHERE script_id = '<id>'`.

| Column | Type | Description |
|---|---|---|
| `line` | number | Line number |
| `text` | string | Source line content |

### console
Console messages captured from the target.

| Column | Type | Description |
|---|---|---|
| `id` | number | Message index |
| `type` | string | log, warn, error, etc. |
| `text` | string | Message content |
| `ts` | number | Timestamp |
| `stack` | string | Stack trace (if available) |

### exceptions
Thrown exceptions.

| Column | Type | Description |
|---|---|---|
| `id` | number | Exception index |
| `text` | string | Error message |
| `type` | string | Exception type |
| `file` | string | Source file |
| `line` | number | Line number |
| `ts` | number | Timestamp |
| `uncaught` | boolean | Was unhandled |

### async_frames
Async stack trace continuation frames.

| Column | Type | Description |
|---|---|---|
| `id` | number | Frame index |
| `function` | string | Function name |
| `file` | string | Source file |
| `line` | number | Line number |
| `parent_id` | number | Parent async frame |

### listeners
Event listeners on an object. **Requires** `WHERE object_id = '<id>'`.

| Column | Type | Description |
|---|---|---|
| `type` | string | Event type (click, message, etc.) |
| `handler` | string | Handler function name |
| `once` | boolean | One-shot listener |
| `use_capture` | boolean | Capture phase |

## Event Log Tables

### events
Raw event log. All daemon activity recorded to SQLite.

| Column | Type | Description |
|---|---|---|
| `id` | number | Auto-increment ID |
| `ts` | number | Timestamp (ms since epoch) |
| `source` | string | Event source (cdp_send, cdp_recv, daemon, etc.) |
| `category` | string | Category: daemon, connection, cdp |
| `method` | string | CDP method or lifecycle event name |
| `data` | string | JSON payload |
| `session_id` | string | Session ID for correlation |

### cdp / cdp_messages
CDP protocol messages with latency metrics. `cdp_messages` is an alias.

| Column | Type | Description |
|---|---|---|
| `id` | number | Event ID |
| `ts` | number | Timestamp |
| `direction` | string | `send` or `recv` |
| `method` | string | CDP method name |
| `latency_ms` | number | Round-trip latency (send events only) |
| `error` | string | Error message (if failed) |
| `data` | string | JSON payload |

### connections
Connection lifecycle events.

| Column | Type | Description |
|---|---|---|
| `id` | number | Event ID |
| `ts` | number | Timestamp |
| `event` | string | connect, disconnect, reconnect, error |
| `session_id` | string | Session ID |
| `data` | string | JSON payload (wsUrl, error details, etc.) |

### timeline
Unified, compact incident timeline across daemon, debugger, CDP, and browser activity.
Backed by EventStore records with canonical ingest-time ordering.
Compact mode suppresses startup debugger noise (`Debugger.scriptParsed`, execution-context churn) by default.
Methods are normalized to canonical names (for example, `Debugger.scriptParsed.undefined` is reported as `Debugger.scriptParsed`).

| Column | Type | Description |
|---|---|---|
| `id` | number | Canonical event ID |
| `ts` | number | Timestamp (ms since epoch) |
| `stream` | string | Normalized stream (`network`, `debugger`, `page`, `daemon`, etc.) |
| `phase` | string | Phase (`request`, `response`, `event`, `error`, etc.) |
| `entity` | string | Correlation key (`requestId`, `frameId`, `scriptId`, etc.) |
| `method` | string | Original event/method name |
| `summary` | string | Compressed human-readable summary |
| `severity` | string | `trace`, `info`, `warn`, or `error` |
| `duration_ms` | number | Latency/duration when available |
| `session_id` | string | Session ID for correlation |
| `raw_ref` | string | Back-reference into raw events (e.g. `events:123`) |
| `detail` | string | Effective detail mode (`compact`, `standard`, `full`) |
| `include` | string | Effective stream filter mode |
| `window_ms` | number | Effective correlation window around anchor |

## Browser Tables

### network
HTTP network requests and responses. Accumulated from Network domain events.

| Column | Type | Description |
|---|---|---|
| `id` | string | Request ID |
| `method` | string | HTTP method (GET, POST, etc.) |
| `url` | string | Request URL |
| `status` | number | HTTP status code |
| `type` | string | Resource type (Document, XHR, Fetch, etc.) |
| `mime_type` | string | Response MIME type |
| `duration_ms` | number | Request duration in milliseconds |
| `size` | number | Response size in bytes |
| `error` | string | Error text (if failed) |
| `initiator` | string | What initiated the request |

### network_headers
HTTP headers for a specific request. **Requires** `WHERE request_id = '<id>'`.

| Column | Type | Description |
|---|---|---|
| `request_id` | string | Parent request ID |
| `direction` | string | `request` or `response` |
| `name` | string | Header name |
| `value` | string | Header value |

### network_body
Response body content. **Requires** `WHERE request_id = '<id>'`. Makes on-demand CDP call.

| Column | Type | Description |
|---|---|---|
| `request_id` | string | Request ID |
| `body` | string | Response body content |
| `base64_encoded` | boolean | Whether body is base64-encoded |

### page_events
Page lifecycle events (load, DOMContentLoaded, frameNavigated, etc.).

| Column | Type | Description |
|---|---|---|
| `id` | number | Event index |
| `name` | string | Event name |
| `ts` | number | Timestamp |
| `frame_id` | string | Frame ID |
| `url` | string | Frame URL |

### dom
DOM elements matching a CSS selector. **Requires** `WHERE selector = '<css>'`. Makes on-demand CDP calls.

| Column | Type | Description |
|---|---|---|
| `node_id` | number | DOM node ID |
| `tag` | string | HTML tag name |
| `id` | string | Element ID attribute |
| `class` | string | Element class attribute |
| `text` | string | Text content (trimmed, max 200 chars) |
| `attributes` | string | All attributes as key=value pairs |

### styles
Computed CSS styles for a node. **Requires** `WHERE node_id = <id>`. Makes on-demand CDP call.

| Column | Type | Description |
|---|---|---|
| `node_id` | number | DOM node ID |
| `name` | string | CSS property name |
| `value` | string | Computed value |

### performance
Runtime performance metrics from Performance.getMetrics.

| Column | Type | Description |
|---|---|---|
| `name` | string | Metric name |
| `value` | number | Metric value |

### cookies
Browser cookies for the current page.

| Column | Type | Description |
|---|---|---|
| `name` | string | Cookie name |
| `value` | string | Cookie value |
| `domain` | string | Cookie domain |
| `path` | string | Cookie path |
| `expires` | number | Expiry timestamp |
| `size` | number | Cookie size |
| `http_only` | boolean | HttpOnly flag |
| `secure` | boolean | Secure flag |
| `same_site` | string | SameSite policy |

### storage
localStorage or sessionStorage entries. **Requires** `WHERE type = 'local'` or `WHERE type = 'session'`.

| Column | Type | Description |
|---|---|---|
| `type` | string | `local` or `session` |
| `key` | string | Storage key |
| `value` | string | Storage value |

### ws_frames
WebSocket frames captured from Network domain events.

| Column | Type | Description |
|---|---|---|
| `id` | number | Frame index |
| `request_id` | string | Parent WebSocket request ID |
| `opcode` | number | WebSocket opcode |
| `data` | string | Frame data |
| `ts` | number | Timestamp |
| `direction` | string | `sent` or `received` |

### coverage
Code coverage data. Requires `dbg coverage start` before page interaction, then query after `coverage stop`.

| Column | Type | Description |
|---|---|---|
| `url` | string | Script/stylesheet URL |
| `total_bytes` | number | Total bytes |
| `used_bytes` | number | Used bytes |
| `used_pct` | number | Usage percentage (0-100) |
