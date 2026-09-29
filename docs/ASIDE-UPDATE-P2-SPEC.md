# P2 specification: Queue control, interruption, and richer model state

**Status:** Draft for implementation; no runtime changes authorised by this document.  
**Date:** 2026-09-29.  
**Source:** [Aside update research](ASIDE-UPDATE-RESEARCH-2026-09-29.md), §7 items 12–18 and §8 mobile constraints.  
**Reference versions:** Browser `1.0.928.1`, agent `1.26.928.1922`, CLI `1.26.916.1741`, per the research.  
**Dependencies:** [P0](ASIDE-UPDATE-P0-SPEC.md) effort/stop groundwork; [P1](ASIDE-UPDATE-P1-SPEC.md) capability plumbing, confirmation/project contracts, and the shared Mini App steering dispatcher.

## Outcome and scope

Give phone users visible control over waiting messages and interruptions, show only effective model capabilities, and retain drafts when approval/question surfaces take over. Keep one execution owner per session, truthful dispatch labels, and the current CLI/facade/data-source architecture.

| Research item | Requirement | Primary implementation surface |
|---|---|---|
| 12 | P2-1: Queue list, edit, delete | `exec.ts`, `app.ts`, `ws.ts`, client API/types, `useThread.ts`, running-thread UI |
| 13 | P2-2: Busy Send now | `Composer.tsx`, send API, runner dispatch |
| 14 | P2-3: Telegram `/steer` and thread interruption | `bridge.py`, shared Mini App dispatcher, thread UI |
| 15 | P2-4: Model picker parity | `ModelSheet.tsx`, provider marks, effort labels/types |
| 16 | P2-5: Fast mode | catalog/types, model/effort selection, runner argv and batching |
| 17 | P2-6: Ultrabrowse copy | `ModelSheet.tsx`: `ReasoningSheet` |
| 18 | P2-7: Draft preservation | `App.tsx`, `Composer.tsx`, `QuestionCard.tsx`, `useAttachments.ts` |

## P2-1: Make the local queue visible and editable

The server's current queue is an in-memory array of `TurnRequest`; clients receive only a count. Extend that existing queue, not the private daemon queue. Scope the editable list to Mini App/PWA-owned waiting requests. The Python bridge's `TASKS` is separate and is not edited through this list.

### Data and lifecycle

Assign each accepted message a stable opaque id, creation time, revision, and captured execution values: raw user text, receipt-backed attachment metadata, effective model/effort/speed, project context, confirmation/reminder policy, and delivery behavior. Use a stable client submission id to deduplicate retries during the server process lifetime; reusing an id with changed content is a conflict. Keep the acknowledgement records bounded and do not promise deduplication across a server restart. Keep raw user content separate from the prepared CLI prompt so editing cannot strip or expose bridge instruction blocks.

Define queue states as waiting, editing, paused, blocked, and claimed/running. Counts include every accepted unclaimed item, including held or blocked ones. The edit/delete boundary is an atomic claim by the runner, not the arrival of a transcript bubble. A claimed message is immutable and leaves the editable list even if the CLI has not emitted output. Compatible adjacent messages may still batch only after all claimed values match; preserve their individual ids for client acknowledgement and transcript reconciliation.

Provide authenticated snapshot and mutation operations, with semantics equivalent to:

| Operation | Proposed route | Result |
|---|---|---|
| Read queue | `GET /api/sessions/:id/queue` | Revision, pause state/reason, ordered safe item summaries |
| Begin edit | `POST /api/sessions/:id/queue/:messageId/edit` | Hold that waiting item and issue a bounded edit lease |
| Save edit | `PATCH /api/sessions/:id/queue/:messageId` | Validate revision/lease, replace raw text, release hold |
| Cancel edit | `POST /api/sessions/:id/queue/:messageId/cancel-edit` | Release the lease without changing content |
| Delete waiting item | `DELETE /api/sessions/:id/queue/:messageId` | Remove that item atomically |
| Resume queue | `POST /api/sessions/:id/queue/resume` | Release interruption pause through the existing dispatcher |

These are proposed bridge routes, not discovered Aside endpoints. Preserve existing send/count fields for old clients. Send a dedicated queue snapshot/change event over authenticated WebSocket, and refetch on reconnect. Do not encode queue edits as fake transcript deltas.

A held head item blocks later FIFO work so a user can finish editing. Bound the lease to two minutes; disconnect/expiry releases it and leaves the original text intact. A second client cannot edit/delete through someone else's lease. Saving against a stale revision or already claimed item returns a conflict and retains the local edited draft. Deletion is limited to waiting requests; it cannot stop execution or delete transcript history.

Preserve receipt validation, size caps, and original captured attachments/settings when editing text. If a receipt expires before dispatch, mark the message blocked with a reattach/remove remedy rather than execute without its attachment. Do not silently recapture a new model, project, or speed when text is edited. Add a finite per-session waiting-item bound, proposed at 100, reject further submissions visibly, and never evict accepted work.

### Phone UI

Show a `Queued messages` count/chip above the reply composer. Open an adaptive surface listing each waiting message's text preview, attachment names, and explicit Edit/Delete actions. Use 48 px rows and 44 px action hit areas. Editing opens a separate controlled draft with Save and `Cancel queue edit`; it does not overwrite the unsent composer draft. Show `Failed to edit the message.` with retryable detail when saving fails.

Show interruption pause as `Queue paused because you interrupted` with Resume queued messages. Keep errors and lease expiry visible. Ask for a short confirmation before discarding a waiting message; on success remove it from the list and reduce the count. Avoid swipe-only deletion, drag reorder, or long-press discovery.

**Acceptance:** Multiple waiting items have stable ids/order and remain individually editable before batching. Save changes only the intended raw text; Cancel preserves the original and the composer draft. Edit/dispatch/delete races have one outcome, never an edited-and-executed duplicate. Two clients reconcile counts and revisions after reconnect. Held head/lease expiry, expired attachments, bound overflow, paused/resumed state, and already-claimed mutations behave as defined. A non-owner or wrong-origin cookie request cannot read or mutate the queue.

**Durability boundary:** Queue work remains process-local in this tier. Server restart may lose waiting items and edit leases, as it does today; disclose that in the queue surface and clear stale client entries after reconnect. Do not add an unrequested persistent job system or imply reload and restart have the same guarantees. Recovery may transfer a waiting queue to a replacement session only through one atomic ownership change, preserving ids/order/pause state; otherwise leave it paused with an explicit destination choice.

## P2-2: Make “Send now” mean something different from FIFO

While a thread is running and a valid draft can send, use accessible label `Send now` and visible caption `Send at the next opportunity instead of waiting in the queue`. Idle label remains Send. With no sendable draft, Stop remains available. Keep separate stop/send controls and their 48 px hit areas; do not hide the user's only stop path behind a new mode selector.

The research's wording promises bypassing waiting messages, while P1 Queue retains FIFO. **Proposed bridge resolution:** capture `delivery: 'normal' | 'now'` with each request. The busy Send now button explicitly sends `now`; ordinary accepted Queue requests retain FIFO. Under Queue behavior, `now` goes ahead of ordinary waiting items at the next completed-turn boundary and does not stop the active run. Multiple `now` requests retain arrival order within that priority group. Under Steer behavior, use the P1 steering dispatcher and pause the existing backlog. Never batch across delivery groups or policy differences.

This priority is a P2 extension to P1's FIFO, not a claim about unisolated desktop queue layout. Do not implement the label as a cosmetic rename of FIFO, or use plain `session resume` against a busy session. Do not introduce a per-send queue/steer chooser; the preference still controls interruption behavior.

Expose the accepted result honestly: immediate/steering, waiting for the active turn's boundary, or paused. If the run settles before the request is accepted, dispatch once using the idle path. A rejected/ambiguous operation keeps the draft and does not claim it was sent. Clients older than this contract, which omit `delivery`, keep their ordinary FIFO behavior.

**Acceptance:** With active A and ordinary backlog B/C, a Queue-mode Send now D runs after A and before B/C; two priority sends keep their submission order. A Steer-mode Send now uses one steering operation and pauses B/C. Idle/completion races do not duplicate D. The caption is visible without hover and linked to the send control for accessibility. Busy/empty, uploading, incompatible model, blocked native question, stop-in-progress, and failed-send states cannot bypass validation.

**Completion gate:** Verify the chosen CLI lifecycle before exposing the caption. If interruption or turn-boundary priority cannot be made effective, retain truthful Queue wording and report item 13 incomplete rather than promise priority. Desktop layout uncertainty does not block this defined bridge policy.

## P2-3: Add explicit interruption on both surfaces

### Telegram `/steer`

Recognise `/steer <prompt>` and the existing bot-suffix command form in the owner-only immediate command path. Parse the entire remainder as prompt text, preserving case, spaces, punctuation, and newlines; the current lowercased single `arg` parser is unsuitable. Empty input returns usage and invokes no CLI.

Target the active run's captured session id, not a mutable picker selection. Require an actual known active session; idle/no-session use reports `No task is running. Send a normal message to start one.` A bootstrap without a known id remains unavailable.

Call the configured CLI as an argv array equivalent to `aside session steer <id> -- <prompt>`, with the bridge's mobile reminder and a bounded acknowledgement timeout. Verify positional `--` handling against the installed CLI. Do not use Stop followed by Resume as a substitute: it can lose the live action state. A command acknowledgement is not proof the interrupted task has finished.

After successful interruption, keep previously waiting Telegram messages paused and say how many remain. Add `/queue resume` to release them explicitly; include both commands in source help. Ordinary subsequent text does not silently resume the old backlog. Stop retains its P0 cancellation behavior. Preserve the worker's streaming/busy bookkeeping, and avoid expiry recovery or generic crash messages when the original driver settles due to steering.

CLI failures retain waiting work and the steering text for an explicit retry; ambiguous acknowledgement must not auto-resend. A session switch or task completion race cannot redirect the command to a different session. For a command requested while active but verified idle before invocation, report that the task finished; do not reinterpret an explicit interruption as a new task.

### Running-thread “Interrupt with…”

Show an explicit `Interrupt with…` action while a Mini App/PWA thread is genuinely running and steer capability is verified. It opens a small prompt form, independent of the composer draft; submitting uses the P1 dispatcher with an explicit steer intent regardless of the default preference. Disable it during native suspension, another control operation, or stopping. Keep its text on failure; close only after accepted acknowledgement.

Reuse P1's paused backlog and P2-1's resume control. Do not change the user's saved Follow-up behavior from this one explicit action. Add no private daemon route or general Python-to-Mini-App queue coordinator.

**Acceptance:** A mixed-case, multiline, dash-leading `/steer` prompt reaches the CLI unchanged as one positional argument. Non-owner/empty/idle requests spawn nothing. Active-session switches cannot mis-target; original streaming settles truthfully; waiting messages pause and resume in order. The thread action sends one explicit steer without changing preferences or the composer draft. Live driver interaction remains a separate acceptance gate.

## P2-4: Preserve existing model-picker parity and close remaining gaps

The inspected `ModelSheet` already has provider headers, `ProviderMark` on every model row, GPT search normalisation, and `No matching models`. `EFFORT_LABELS` already maps `xhigh` to `Extra High`. Treat these as required behavior to preserve, not unfinished features to rebuild.

Keep the current provider first, retain authoritative provider inventory/visibility handling, and preserve selected checks. Carry verified `shortName` when present; otherwise retain the current model label. Keep provider identity accessible through the row text/group, with decorative glyphs hidden. Unknown providers use the existing neutral fallback; do not add a provider-connect row the bridge cannot action.

Integrate P0's model-specific effort choices and P1's image filter without losing grouping, search, empty-state distinctions, or current selection. Keep Extra High as the full menu label; a compact pill may use existing abbreviations only with an explicit full accessible name.

**Acceptance:** Known and unknown provider fixtures retain grouping/marks; current-provider ordering and GPT normalisation work. Text search with no match says `No matching models`; no configured models and no supporting image models have distinct explanations. Max and image gating survive provider changes, and Extra High stays correctly labelled. Avoid a broad UI rewrite if these checks already pass.

## P2-5: Add Fast mode only with verified capability and entitlement

Carry verified `supportsFastMode` alongside P1/P0 catalog capabilities. Preserve missing data as unknown. Obtain a non-secret account-tier/entitlement summary through an existing supported read-only source; the current Mini App status/catalog does not supply it. Do not infer paid eligibility from a model label, connected provider, credential value, or saved fast preference.

Expose a `Fast mode` switch for a model declaring support. Show `Significantly faster, consumes more usage` inline before activation. Add a small sky dot to the provider glyph when effective, with an accessible Fast mode state. Preserve the provider's recognisable mark; the dot supplements the state text and is not the sole indication.

Disable the switch for a verified free tier and for unknown capability/entitlement, with different inline reasons. Do not supply a guessed upgrade URL. Model switching to unsupported/unknown clears the draft's effective fast selection and explains it. No global/account-wide setting is written.

Capture `speed: 'default' | 'fast'` with each accepted request, including new, queued, recovered, and continuation requests. For fast requests, pass a verified `-s/--speed fast` argv form at both runner spawn sites. The server validates capability and eligibility before spawning even if the client directly requests fast. Do not silently run default after accepting fast.

Speed is part of the batching compatibility key alongside model, effort, project/reminder policy, and delivery behavior. Previously accepted requests retain their speed if the UI selection changes. Steering has no established per-request speed flag in the research: preserve the active run's speed, show that fact, and reject any incompatible requested speed rather than imply the steering CLI changed it.

**Acceptance:** Eligible supporting models enable fast and put the exact fast flag in new/continuation argv. Free/unknown/unsupported fixtures disable UI and fail direct fast API requests before execution. Provider identity remains readable with the dot in both themes. Queued messages of different speeds never batch; switching models or expiry recovery cannot silently enable fast. A CLI speed rejection is visible and retains the request for correction.

**Blocking evidence:** Research establishes extension fields and CLI speed choices, not a supported local entitlement source or reliable effective speed. If either source is unavailable, keep Fast mode disabled and report item 16 incomplete. Do not adopt private tRPC, hardcode the account tier, or add an entitlement override to bypass this gate.

## P2-6: Replace the disabled Ultrabrowse caption

Use exactly `Upgrade to Pro and unlock Ultrabrowse for deep research and complex tasks.` as the inline subtitle on the disabled Ultrabrowse row. Preserve the existing disabled state and visual treatment; copy does not establish account eligibility or enable the feature. Add no checkout/link without a verified destination and separate scope.

**Acceptance:** The exact caption is visible in the effort surface without hover in both themes; tapping or keyboard activation cannot select the disabled row. No account mutation or upgrade transaction occurs.

## P2-7: Preserve drafts when cards take over

The composer already uses a controlled `draft` in `App.tsx`; that is not proof of independent per-thread preservation or attachment survival. Introduce per-destination draft ownership: one new-chat draft and one per session, with text, attachment descriptors/previews/upload state, and effective pending choices. Keep queue-edit and interruption drafts separate.

When an approval/question surface replaces or blocks the composer, keep that draft intact and show a `role="status"` line: `Your message draft is saved and will return when this closes.` Card replies do not overwrite or submit it. On dismissal/settlement/recovery, restore the correct destination's text and valid attachments; rebind a recovered thread's draft exactly once to its replacement identity. Returning to another thread restores its own draft.

Clear a composer draft only after the server accepts its submission. A network/validation failure restores text and attachments rather than relying on an optimistic bubble as the only surviving copy. Existing optimistic transcript display must distinguish rejected/uncertain dispatch from accepted work. Revalidate expired upload receipts on restoration and offer reattachment; do not present an expired chip as ready or silently drop it.

“Saved” in this tier means retained in the current app session across card and navigation transitions. Do not persist private unsent text to browser storage or disk without separate scope. A full page reload/browser termination remains outside this guarantee. Only show the reassurance when a draft is actually retained; include a nearby session-only note where needed to avoid implying durable storage.

Dispose preview URLs only when that draft/attachment is deliberately discarded or successfully transferred, not when a card temporarily unmounts the composer. Bound retained draft entries, proposed at 20 destinations; if full, require explicit discard of an existing nonempty draft rather than silently evicting unsent text. Clean up successful empty drafts automatically.

**Acceptance:** Text and ready/uploading attachments survive an approval, an ordinary question, native blocking, navigation between two threads, and explicit recovery. Answering/cancelling a card does not send the composer draft. Failed send retains it; accepted send clears only that destination. Expired receipts become actionable failed chips. Preview URLs stay valid across transitions and are revoked on final removal. Capacity handling cannot silently lose an unsent draft. Reload persistence is neither implied nor tested as supported.

## Delivery, verification, and limits

Build queue identity/claim/revision events first, then edit UI and priority dispatch. Add explicit interruption on top of the P1 dispatcher. Preserve existing picker parity; Fast mode waits for verified sources. Finish draft ownership and failure restoration before declaring the mobile flow complete.

Use focused fake-child tests for lifecycle/order/exactly-once races, route tests for queue revisions and authentication, and component tests for edit/draft restoration and capability state. Run affected offline Python scripts directly for `/steer` and resume behavior. Run Mini App typecheck, isolated workspace tests (`MINIAPP_PORT=8792 MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0 npm test`), and build after shared changes. Independently review concurrency, queue ownership, retained data, and capability enforcement before shipping runtime changes.

Inspect light/dark phone layouts at 320, 375, 390, and 430 px plus 768 px: large queues, long previews, keyboard/lease expiry, 200% text zoom, reduced motion, screen-reader state announcements, busy/paused/blocked/recovery/error states. Apply P1's 44/48 px hit targets and visible labels. Use explicit UI confirmation before deleting queued text; no swipe-only destructive action.

Verify steering, stop coexistence, and fast execution using an authorised throwaway live session. Record actual CLI and browser/agent versions at implementation time. Source review and mocked tests do not prove daemon priority/step boundaries, account entitlement, Telegram OS pickers, or physical-device behavior. No live probe is authorised merely by this draft.

**Non-goals:** durable jobs/offline sync, arbitrary queue reordering, editing running or historical messages, a shared Python/Node queue, branching/subagent/routine UI, model-preset redesign, provider-connect flows, native project moves, native approval mutations, private tRPC, proprietary fonts, Aside v2 redesign, deployment/service changes.

**Unresolved evidence:** desktop queue layout was not isolated; this spec therefore defines bridge behavior explicitly. Speed metadata/entitlement and steer/driver lifecycle need supported sources and controlled checks. The official Aside Telegram surface remains unresolved in research §10.7 and matters to long-term investment, but confirming it is separate research rather than an extra P2 feature.
