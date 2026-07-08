# @dbg/tables-core

Core virtual tables for the dbg SQL query engine. These tables work with both CDP and DAP sessions.

## Public API

- `registerCoreTables(registry)`: Register all core tables into a `QueryRegistry`.

### Tables

| Table | Description | Key Columns |
|---|---|---|
| `frames` | Call stack frames | `id`, `function`, `file`, `line`, `col`, `url`, `script_id` |
| `scopes` | Scope chains per frame | `id`, `frame_id`, `type`, `name`, `object_id` |
| `vars` | Variables (defaults to frame 0, skips global) | `frame_id`, `scope`, `name`, `type`, `value`, `object_id` |
| `this` | `this` binding per frame | `frame_id`, `type`, `value`, `object_id` |
| `props` | Object properties (requires `WHERE object_id=`) | `name`, `type`, `value`, `child_id` |
| `proto` | Prototype chain (requires `WHERE object_id=`) | `depth`, `type`, `value` |
| `breakpoints` | All set breakpoints | `id`, `file`, `line`, `condition`, `hits`, `enabled` |
| `scripts` | Loaded scripts | `id`, `file`, `url`, `lines`, `source_map`, `is_module` |
| `source` | Source lines (requires `WHERE file=` or `script_id=`) | `line`, `text` |
| `console` | Console output | `id`, `type`, `text`, `ts`, `stack` |
| `exceptions` | Thrown exceptions | `id`, `text`, `type`, `file`, `line`, `ts`, `uncaught` |
| `async_frames` | Async stack traces | `id`, `function`, `file`, `line`, `parent_id`, `description` |
| `listeners` | Event listeners (requires `WHERE object_id=`) | `type`, `handler`, `once` |
| `events` | Raw event log from SQLite store | `id`, `ts`, `source`, `category`, `method`, `data`, `session_id` |
| `cdp` / `cdp_messages` | CDP message view with latency | `id`, `ts`, `direction`, `method`, `latency_ms`, `error`, `data` |
| `connections` | Connection lifecycle events | `id`, `ts`, `event`, `session_id`, `data` |
| `timeline` | Unified issue timeline | `id`, `ts`, `stream`, `method`, `severity`, `summary` |

## Dependencies

- `@dbg/query` (internal) -- `QueryRegistry`, `VirtualTable`
- `@dbg/types` (internal) -- `DebugExecutor`

## Dependents

- `@dbg/cli` -- registers core tables in daemon

## Testing

```sh
pnpm run build && vitest run
```
