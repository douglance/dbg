# @dbg/tables-native

Native debug virtual tables for the dbg SQL query engine. Only available for DAP sessions (LLDB targets).

## Public API

- `registerNativeTables(registry)`: Register all native tables into a `QueryRegistry`. Tables are tagged with `protocols: ["dap"]`.

### Tables

| Table | Description | Key Columns |
|---|---|---|
| `registers` | CPU register values (graceful error on physical device disconnect) | `group`, `name`, `value` |
| `memory` | Process memory (requires `WHERE address=` and `length=`) | `offset`, `hex`, `ascii` |
| `disassembly` | Disassembled instructions (requires `WHERE address=`) | `address`, `instruction`, `operands`, `comment` |
| `threads` | Active threads | `id`, `name`, `stopped` |
| `modules` | Loaded modules/libraries | `id`, `name`, `path`, `base_address`, `size` |
| `watchpoints` | Hardware watchpoints | `id`, `address`, `size`, `type`, `hits` |
| `signals` | Signal information | `name`, `number`, `pass`, `stop`, `notify` |

## Dependencies

- `@dbg/query` (internal) -- `QueryRegistry`, `VirtualTable`
- `@dbg/types` (internal) -- `DebugExecutor`

## Dependents

- `@dbg/cli` -- registers native tables in daemon

## Testing

```sh
pnpm run build && vitest run
```
