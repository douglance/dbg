# Virtual Table Reference

Detailed column schemas for all 16 virtual tables in dbg.

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
