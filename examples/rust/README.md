# Rust + dbg Example

This folder contains a minimal native-debug example that drives `dbg` from Rust.

## Files

- `target.rs`: tiny Rust program to debug.
- `debug_with_dbg.rs`: Rust automation script that:
  1. compiles `target.rs` with debug symbols,
  2. ensures the `dbg` daemon is running on an isolated socket,
  3. sends daemon JSON commands over the Unix socket,
  4. runs an LLDB flow (`attach-lldb`, `status`, frame/thread queries, `n`, `trace`, `close`).

## Run

From repo root:

```bash
pnpm build
rustc -g examples/rust/debug_with_dbg.rs -o /tmp/dbg-rust-driver
/tmp/dbg-rust-driver
```

## Environment variables

- `DBG_SOCK` (default: `/tmp/dbg-rust.sock`)
- `DBG_EVENTS_DB` (default: `/tmp/dbg-rust-events.db`)
- `RUST_DEBUG_TARGET` (default: `examples/rust/target.rs`)
- `RUST_DEBUG_BIN` (default: `/tmp/dbg-rust-target`)

## macOS note

If `attach-lldb` fails due permissions, grant your terminal/shell Developer Tools permission and retry.
