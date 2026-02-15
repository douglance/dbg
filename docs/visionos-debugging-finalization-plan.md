# VisionOS Debugging Finalization Plan

## Summary

Finalize end-to-end on-device debugging for visionOS apps through `dbg attach` so that Vision Pro sessions support reliable attach, pause, stack frames, breakpoints, stepping, and detach.

Current status:

- Provider resolution is implemented and verified (`device -> app -> pid`).
- CLI/daemon/DAP wiring exists for `dbg attach ... --provider apple-device --platform visionos`.
- Blocking gap: LLDB-DAP attach path reaches LLDB "connected/running" but does not consistently reach DAP-required *stopped* state on physical visionOS devices.

## Success Criteria

For a real Vision Pro device and `com.workstation.app` (visionPTY):

1. `dbg attach ...` returns success with a live session.
2. `dbg status` reports a connected native session.
3. `dbg pause` succeeds.
4. `dbg q "SELECT * FROM frames LIMIT 5"` returns real frame rows.
5. `dbg b <file:line>` then `dbg c` hits breakpoint.
6. `dbg close` detaches cleanly without killing the app.
7. On failure, errors are typed/actionable (no generic daemon timeouts).

## Scope

In scope:

- Physical Apple-device attach for visionOS through existing `attach` command.
- LLDB-DAP strategy fallback and stop-state handshake.
- Diagnostics, CLI controls, and hardware smoke validation.

Out of scope:

- Simulator-only debugging improvements.
- Non-Apple providers (ADB, Windows, Linux).
- Refactoring unrelated CDP/browser debugging paths.

## Verified Technical Facts (Apple/LLDB)

1. Apple CoreDevice guidance uses `devicectl ... launch` followed by LLDB `device select` + `device process attach`.
2. `lldb-dap` attach requires `pid`/`program`/`attachCommands`/`gdbRemotePort`, then waits for process stop (`WaitForProcessToStop`).
3. App signing entitlement still matters (`get-task-allow` required for debug attach in development).
4. Therefore, provider discovery is necessary but not sufficient; attach transport + stop-state transition must be solved.

## Implementation Plan

### Phase 1: Add Explicit Attach Strategy Layer

Create strategy manager for native Apple-device attach in daemon:

- `auto` (default)
- `device-process` (current attachCommands path)
- `gdb-remote` (new fallback path using LLDB-DAP gdb-remote flow)

Behavior:

1. `auto` tries `device-process`.
2. On stop-state timeout/failure, fall back to `gdb-remote`.
3. If both fail, return typed provider error with strategy-specific diagnostics.

### Phase 2: Implement GDB-Remote Fallback Path

Implement fallback in adapter/daemon:

1. Establish remote debug channel compatible with LLDB-DAP `gdbRemotePort` attach.
2. Pass required DAP attach args for gdb-remote mode.
3. Ensure this path is selected only for Apple-device native sessions.

Notes:

- Keep strategy encapsulated so future iOS/tvOS/watchOS extension is trivial.
- Preserve existing provider contract (`ProviderResolutionResult`).

### Phase 3: Enforce Stop-State Handshake Before Session Registration

Daemon must not register a successful session until handshake passes:

1. DAP attach request success.
2. `threads` request returns at least one thread.
3. `stackTrace` request succeeds for selected thread.

If any step fails:

- detach/cleanup transport.
- return `attach_denied_or_timeout` with actionable hint.
- record full failure event in event store.

### Phase 4: Improve Diagnostics and Operability

Add structured diagnostics to event store:

- selected strategy
- attempted strategies
- per-stage timings:
  - provider resolve
  - DAP initialize
  - DAP attach
  - threads probe
  - stack probe
- raw LLDB/DAP error class/message

Add CLI controls:

- `--attach-strategy auto|device-process|gdb-remote`
- `--attach-timeout <seconds>`
- `--verbose-attach` (prints strategy + timing checkpoints)

### Phase 5: Reliability Hardening

1. Add request-level timeouts for all critical DAP steps.
2. Ensure detach on every attach failure path.
3. Ensure stale daemon/lldb-dap processes cannot retain device debug lock.

### Phase 6: Testing

Unit tests:

1. strategy selection in `auto` mode.
2. fallback trigger conditions.
3. error mapping to `ProviderErrorCode`.
4. stop-state handshake gating session creation.

Integration tests (repo):

1. attach failure path returns typed error (not socket timeout).
2. attach strategy flag routes correctly.
3. event store includes expected diagnostics fields.

Hardware smoke script (manual gate):

Create `scripts/visionos-attach-smoke.ts` (or `.sh`) to run:

1. launch app on device.
2. attach with selected strategy.
3. status.
4. pause.
5. frames query.
6. optional breakpoint smoke.
7. close and verify cleanup.

## Public Interface Changes

CLI:

- Extend `attach` flags:
  - `--attach-strategy`
  - `--attach-timeout`
  - `--verbose-attach`

No breaking protocol changes required beyond existing `attach` command migration.

## Failure Modes and Expected Responses

1. App not installed:
   - `app_not_installed`
2. App not running / PID missing:
   - `process_not_running`
3. LLDB cannot stop process in configured timeout:
   - `attach_denied_or_timeout` with strategy and hint
4. LLDB-DAP unavailable:
   - `lldb_dap_unavailable`
5. Unknown provider/attach internal error:
   - `provider_error`

## Rollout

1. Implement strategy manager + fallback behind default `auto`.
2. Land tests and smoke script.
3. Validate on your Vision Pro + `visionPTY`.
4. Mark feature complete when success criteria are all green.

## Assumptions

1. Vision Pro is paired and visible in `devicectl list devices`.
2. Developer mode and DDI services are healthy on device.
3. App build is signed for debugging (`get-task-allow = true`).
4. No concurrent debugger session is attached when smoke tests run.

## Reference Links

- LLDB DAP usage: https://lldb.llvm.org/use/lldbdap.html
- LLDB remote debugging: https://lldb.llvm.org/use/remote.html
- LLDB-DAP attach handler source: https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/tools/lldb-dap/Handler/AttachRequestHandler.cpp
- Apple `devicectl` launch+attach guidance (local help): `xcrun devicectl help device process launch`
- Apple debugging/hardened runtime context: https://developer.apple.com/la/videos/play/wwdc2019/703/
- Apple forums attach-denial context: https://developer.apple.com/forums/thread/676028
