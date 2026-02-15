# @dbg/tables-browser

Browser-specific virtual tables for the dbg SQL query engine. Only available for CDP sessions (browser page targets).

## Public API

- `registerBrowserTables(registry)`: Register all browser tables into a `QueryRegistry`. Tables are tagged with `protocols: ["cdp"]`.

### Tables

| Table | Description | Key Columns |
|---|---|---|
| `network` | HTTP requests | `id`, `method`, `url`, `status`, `type`, `duration_ms`, `size` |
| `network_headers` | Request/response headers (requires `WHERE request_id=`) | `direction`, `name`, `value` |
| `network_body` | Response body (requires `WHERE request_id=`) | `body` |
| `page_events` | Page lifecycle events | `id`, `name`, `ts`, `frame_id`, `url` |
| `dom` | DOM elements (requires `WHERE selector=`) | `node_id`, `tag`, `attributes`, `text` |
| `styles` | Computed CSS (requires `WHERE node_id=`) | `property`, `value` |
| `performance` | Runtime metrics | `name`, `value` |
| `cookies` | Browser cookies | `name`, `value`, `domain`, `path`, ... |
| `storage` | Web storage (requires `WHERE type=`) | `key`, `value` |
| `ws_frames` | WebSocket frames | `id`, `request_id`, `data`, `ts`, `direction` |
| `coverage` | Code coverage results | `url`, `total_bytes`, `used_bytes`, `used_pct` |

### Stub Tables (planned)

`accessibility`, `animation`, `cache_storage`, `cpu_profiler`, `dom_debugger`, `dom_snapshot`, `heap_profiler`, `indexed_db`, `layer_tree`, `media`, `memory`, `security`, `service_worker`, `tracing`.

## Dependencies

- `@dbg/query` (internal) -- `QueryRegistry`, `VirtualTable`
- `@dbg/types` (internal) -- `DebugExecutor`

## Dependents

- `@dbg/cli` -- registers browser tables in daemon

## Testing

```sh
pnpm run build && vitest run
```
