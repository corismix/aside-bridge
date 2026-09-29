# Agent state

Updated 2026-09-29.

## Current work

Implemented [P0](docs/ASIDE-UPDATE-P0-SPEC.md). Source, regression, and
documentation changes are in the working tree; unrelated tracked files were
not changed. The authorized live `/stop` check used the free
`opencode-go/space-bunny-free` model in throwaway session
`7GzE95UkAs6I0Tp6`; it remains interrupted in Aside. No Telegram service
settings, command menu, or Git history was changed.

## Latest meaningful validation

- Mini App: full server and web Vitest suites pass (563 server tests, 187 web
  tests); typecheck and production build pass. Build reports the existing
  503 kB main-chunk warning.
- Python: `py_compile` and `tests/test_stop_command.py` pass.
- Stop regression runs the real worker/message flow against a blocking fake
  driver and fake stop CLI. It covers successful cancellation, active-session
  targeting after session selection changes, partial output, pending replay,
  preserved commands, idle/bootstrap/malformed use, repeated taps, natural
  completion, CLI failure/timeout, and busy-state recovery. This check found
  and fixed a queue-emptiness bug that left `WORKER_BUSY` set after queued
  commands completed. Approval and question bridge regressions also pass with
  an isolated temporary config.
- Live Stop: `aside session stop` returned success, but the first observed run
  left its CLI waiter blocked. `run_aside` now retains that exact child process;
  after daemon Stop acknowledgement it gives the waiter three seconds, then
  terminates the owned child. The repeat against the throwaway model/session
  exited 143 (SIGTERM), settled the worker, cleared `ACTIVE_RUN`, and cleared
  `WORKER_BUSY`.
- Browser: built client checked in installed Chrome at 320, 390, and 430 CSS
  px, in light/dark home and reply states. Browser simulation does not verify
  Telegram PWA or real keyboard behavior.
- `git diff --check` passes. Temporary QA server was stopped.

## Known boundaries

- P0 Max: local capability metadata is transported and enforced, but effective
  daemon effort is not established by CLI parsing evidence.
- P0 Stop: real CLI/driver settlement was verified. Telegram polling and
  delivery were not exercised against the live bot; command ownership remains
  enforced by the configured private-chat id check.
- P1 remembered approvals: structured action identity and exact scoped grant
  matching.
- P1/P2 image and Fast controls: authoritative catalog capability metadata;
  Fast also needs a supported, non-secret entitlement source.
- P2 Send now: verify turn-boundary priority behavior before presenting it as
  distinct from FIFO.
- P1 attachments: verify video picker behavior on a real target device.
