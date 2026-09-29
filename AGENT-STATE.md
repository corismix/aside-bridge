# Agent state

Updated 2026-09-29.

## Current work

Prepared the implementation handoff for the Aside update specs. P0, P1, and P2
are implementation-ready specifications; this prep changed documentation only.
No runtime code, service, account setting, live Aside session, or Git history
was changed.

The checkout was clean at `6931aa5 feat: improve mini app picker surfaces`
(`main` tracking `origin/main`) when this handoff was written. Recheck status
before editing and preserve any changes that appear later.

## Implementation start

Start with [P0](docs/ASIDE-UPDATE-P0-SPEC.md), then P1 and P2 in dependency
order. The specs are the source of truth for behavior and acceptance; do not
repeat the research pass unless versions or evidence have changed.

1. **P0 foundations:** implement Max enum/capability plumbing first. Max can be
   enabled only for models with verified thinking-level metadata; missing
   metadata blocks selectable Max, not the remaining P0 work. Then handle the
   placeholder and permission copy, Telegram `/stop`, and the transport/design
   docs in the order and with the gates in P0.
2. **P1 mobile behavior:** permission/confirmation, per-thread project
   context, attachment menu, image capability validation, approval contract,
   and Follow-up behavior. Build the shared steering dispatcher before its
   settings/UI path. Keep remembered approvals disabled until structured,
   scoped action identity is available.
3. **P2 queue/interruption:** build on P1's dispatcher and explicit paused
   queue behavior. Establish atomic queue claim/revision semantics before the
   edit UI or priority Send now. Keep Fast unavailable unless both model
   support and entitlement have supported sources.

Do not claim `/stop`, steering, or priority interruption complete until a
controlled driver-lifecycle check proves the active child settles and bridge
state recovers. Run any live/billed check only under explicit authorization.
Unsupported capabilities remain visibly unavailable and are recorded as
incomplete; they must not become guessed defaults or cosmetic controls.

## Latest meaningful validation

Reviewed all three specs and the 2026-09-29 research. Their research items
1–18 map once across P0/P1/P2, with acceptance criteria, target surfaces,
non-goals, and validation guidance. Confirmed P1 steering is a dependency for
P2 and identified model capability sources, approval identity, and live driver
behavior as explicit gates. No runtime tests were run for this documentation
update.

## Next action

Begin the P0 implementation in a fresh pass, first tracing the model catalog
capability fields and existing dispatch/config paths named in the P0 spec.
Before edits, recheck the worktree and re-verify installed Aside/CLI versions
if relying on the dated research evidence.

## Unresolved gates

- P0 Max: verified per-model thinking levels; CLI acceptance alone does not
  prove daemon effectiveness.
- P0 Stop and P1/P2 steering/interruption: controlled driver settlement and
  busy-state recovery.
- P1 remembered approvals: structured action identity and exact scoped grant
  matching.
- P1/P2 image and Fast controls: authoritative catalog capability metadata;
  Fast also needs a supported, non-secret entitlement source.
- P2 Send now: verify turn-boundary priority behavior before presenting it as
  distinct from FIFO.
- P1 attachments: verify video picker behavior on a real target device.
