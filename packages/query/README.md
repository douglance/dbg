# @dbg/query

SQL-like query engine that parses `SELECT` statements and executes them against virtual tables backed by live debugger state.

## Public API

### Parser (`parser.ts`)
- `parseQuery(sql)`: Tokenize and parse a SQL string into a `Query` AST.
- `Query`: `{ columns, table, where, orderBy, limit }`.
- `WhereExpr`: Recursive AST node -- `comparison | and | or | paren`.

### Filter (`filter.ts`)
- `filterRows(columns, rows, where)`: Apply WHERE clause to in-memory rows.
- `orderRows(columns, rows, orderBy)`: Sort rows by column.
- `limitRows(rows, limit)`: Truncate to N rows.

### Engine (`engine.ts`)
- `executeQuery(queryString, executor, registry?)`: Parse, fetch from virtual table, filter/order/limit, return `{ columns, rows, format }`.

### Registry (`registry.ts`)
- `VirtualTable`: Interface for a queryable table (`name`, `columns`, `requiredFilters?`, `protocols?`, `fetch()`).
- `QueryRegistry`: Interface (`register`, `getTable`, `listTables`).
- `TableRegistry`: Default implementation with protocol-aware table lookup.
- `registerTable(table)`, `getTable(name, protocol?)`, `listTables()`, `getDefaultRegistry()`: Module-level convenience functions.

### Utils (`utils.ts`)
- `extractFilterValue(where, column)`: Pull the equality-filtered value for a column from a WHERE clause.

## Supported SQL

```
SELECT [cols | *] FROM <table>
  [WHERE <conditions>]
  [ORDER BY <col> [ASC|DESC]]
  [LIMIT <n>]
```

WHERE operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `AND`, `OR`, `()`.

## Dependencies

- `@dbg/types` (internal) -- `DebugExecutor`, `SessionProtocol`

## Dependents

- `@dbg/tables-core` -- registers core virtual tables
- `@dbg/tables-browser` -- registers browser virtual tables
- `@dbg/tables-native` -- registers native virtual tables
- `@dbg/cli` -- creates `TableRegistry`, calls `executeQuery()`

## Testing

```sh
pnpm run build && vitest run
```
