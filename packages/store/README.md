# @dbg/store

SQLite-backed event store that records all debugger activity (CDP messages, DAP events, connection lifecycle) for post-hoc analysis and virtual table queries.

## Public API

- `EventStore`: Main class. Batches writes (~100ms flush interval) with WAL mode for performance.
  - `constructor(dbPath?)`: Opens or creates the SQLite database. Default: `/tmp/dbg-events.db` (override via `DBG_EVENTS_DB`).
  - `record(event, flushNow?)`: Enqueue an event. Fields: `ts`, `source`, `category`, `method`, `data`, `sessionId`.
  - `flush()`: Force-write pending events to disk in a single transaction.
  - `query(sql, params?)`: Run a SQL query against the events table. Flushes pending writes first.
  - `close()`: Flush and close the database.
- `EventRecord`: Interface for events passed to `record()`.

## Schema

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  method TEXT NOT NULL,
  data TEXT NOT NULL,
  session_id TEXT
);
```

Indexed on `ts`, `source`, `method`, `session_id`.

## Dependencies

- `@dbg/types` (internal) -- `EventStoreLike` interface
- `node:sqlite` (Node.js 22+ built-in)

## Dependents

- `@dbg/adapter-cdp` -- records CDP send/recv/connection events
- `@dbg/adapter-dap` -- records DAP send/recv/lifecycle events
- `@dbg/cli` -- creates the global store, passes to adapters, used for `trace` and event queries

## Testing

```sh
pnpm run build && vitest run
```
