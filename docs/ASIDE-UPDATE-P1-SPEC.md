# P1 specification: Mobile controls and capability-aware follow-ups

**Status:** Draft for implementation; no runtime changes authorised by this document.  
**Date:** 2026-09-29.  
**Source:** [Aside update research](ASIDE-UPDATE-RESEARCH-2026-09-29.md), §7 items 6–11, with phone-specific rules in §8.  
**Reference versions:** Browser `1.0.928.1`, agent `1.26.928.1922`, CLI `1.26.916.1741`, per the research.  
**Dependencies:** [P0](ASIDE-UPDATE-P0-SPEC.md) copy and capability groundwork. P2 reuses the steering dispatcher defined here; see [P2](ASIDE-UPDATE-P2-SPEC.md).

## Outcome and scope

Make permission, confirmation, project context, attachments, approvals, and follow-up behavior usable from a phone. Keep the current CLI/facade and answerable mobile-question architecture. No control may promise an effect the server cannot deliver.

| Research item | Requirement | Primary implementation surface |
|---|---|---|
| 6 | P1-1: Visible permission/confirmation control | `Composer.tsx`, `Pickers.tsx`, `App.tsx`, permission API/store |
| 7 | P1-2: Reply project context and deselection | `ProjectSheet.tsx`, `App.tsx`, `projects.ts`, send API |
| 8 | P1-3: Attachment menu | `Composer.tsx`, `useAttachments.ts`, upload/send API |
| 9 | P1-4: Action approval card | `QuestionCard.tsx`, `questions.ts`, answer API, mobile preamble |
| 10 | P1-5: Image-capable model selection | `desktop.ts`, `catalog.ts`, wire types, model picker, send validation |
| 11 | P1-6: Follow-up behavior | `settings.ts`, `SettingsScreen.tsx`, `exec.ts`, send API |

The current working tree already has provider-grouped model rows, real provider marks, a no-results message, and adaptive sheets. Reuse those components. This tier does not redo the visual system or add desktop-only capabilities.

## P1-1: Show confirmation state in the composer

Use one permission/confirmation control in the left composer group, separate from Project. Its visual permission segment is icon + current mode + chevron. Add a visible, tappable confirmation segment containing a distinct hand/skip glyph and `Ask first` or `Skip confirmation`. Both segments open the same permission sheet; do not depend on long-press or hover to discover confirmation.

Use `data-slot="agent-session-permission-trigger"` on the permission trigger. Accessible names express the state: for example, `Guard, Ask first`; the confirmation segment names its own current value. Unknown state is visibly unknown, never implied to be on or off. If using separate buttons within the visual control, do not nest interactive elements.

Apply the existing orange caution token when permission is Full access or confirmation is explicitly off. Project colors keep their existing meaning. Selecting Skip confirmation does not itself grant broader file permissions.

The sheet contains the P0 permission rows and descriptions, then a divider and confirmation switch. Render these descriptions inline:

| Choice | Description |
|---|---|
| Ask first | Ask before actions like send, pay, delete, or submit. |
| Skip confirmation | Proceed without asking for confirmation. |

For mobile-owned sessions, continue writing `SoftConfirmStore`; the native final-confirm flag remains false. Keep the explanation `Asks here, on a card you can answer. Applies from your next message.` Existing desktop-owned sessions retain their established native behavior and an explicit notice that native prompts require Aside on the computer. The desktop wording is a presentation reference, not authority to switch transports.

Store new-session defaults in the existing Mini App preferences file; retain per-session confirmation in its existing store. Do not read or write `aside.last-final-confirm.v1`, or Aside's global settings. Preserve null/unknown values and existing defaults. Do not automatically disable confirmation based only on the Read only label: research §8.3's “cannot take actions” sentence is not established by the actual mode description. Only add such a rule after the effective restriction is verified.

**Acceptance:** Both composer variants expose mode and confirmation as text. Changing either updates the effective next-message state, survives reload, and never sets native final-confirm true on a mobile session. Failed writes keep the last confirmed state and show an error. Full access/off uses orange; Guard/on is neutral. Unknown state stays unknown. No hover or long-press is required.

## P1-2: Add reply project context without claiming membership

1. Render the existing labelled Project pill in the reply composer. Reuse project glyph/color, duplicate-name workspace subtitles, and the explicit No project row. Tapping an already selected project calls deselection and closes the picker, just like selecting No project.
2. Separate the new-chat project preference from each existing thread's project-context choice. A reply selection must not silently alter the next new chat or another open thread. For bridge-created threads, retain the selected context id as bridge-owned metadata; desktop threads without known bridge context show no assumed project.
3. Define reply selection as context for the **next submitted message**. Resolve its id against the real project list and append the existing bounded workspace/`AGENTS.md`/`MEMORY.md` context through `projectContextBlock`. Store the selection independently of native Aside membership. Snapshot it at send time so queued messages do not acquire a later project choice.
4. Deselecting stops adding that project context to future messages. It cannot erase context already present in the transcript. Show this limitation in the picker, along with `Uses workspace and project instructions as chat context; does not move this chat into the project.` Do not imply a filesystem permission change or a working-directory mutation.
5. Reject a deleted/unresolvable selected project before dispatch and retain the draft. Preserve the selection/context through existing session recovery, with the recovered-session identity updated in bridge metadata.

**Acceptance:** The reply pill appears and opens the same picker as home. Active-row reselection clears it. Two threads keep independent choices, and home preference remains unchanged. A follow-up receives the chosen project's bounded context exactly once for that submission; clearing prevents subsequent injection without claiming previous context was removed. Switching while a request waits cannot retarget it. Invalid ids cause no turn or file read outside the existing project-context path.

**Scope decision:** Research §7 requires reply selection, while §9 excludes native moves. Next-message prompt context is the proposed bridge behavior that satisfies both. Project creation, combining Project and Permission into a new sheet, and move-existing-session controls are outside items 6–11.

## P1-3: Put attachment choices behind `+`

Open an adaptive menu with `Attach photo or video` and `Attach file`, in that order. Use the existing hidden multiple-file input and upload pipeline; change its accept filter for the selected action before opening the OS picker. Keep the attach control's accessible name and focus restoration.

The media choice offers `image/*,video/*`; the file choice retains the supported document types. Video is an attached file the agent may inspect with local tools; it is not a promise of native video understanding. Preserve original MIME/name metadata and render a filename chip for video unless a safe existing preview supports it. Browser cancellation adds nothing and keeps the draft.

Keep the existing five-file and 20 MiB-per-file limits, server-issued upload receipts, filename sanitisation, private storage, and upload failure/retry behavior. Unsupported formats or over-limit files produce an inline error, not a silent omission. An upload in progress blocks sending. Do not add native folder picking, dictation, incognito, or memory/password controls.

**Acceptance:** Each menu action opens the correct filter from a phone-compatible surface. Photos, a video file, and documents pass the same bounded receipt-backed pipeline; arbitrary client paths cannot become attachments. Picker cancellation, mixed upload success/failure, remove, retry, and draft retention work. Actual OS picker behavior in Telegram/iOS needs a device check beyond browser tests.

## P1-4: Make approval choices explicit and transport-correct

Change only `QuestionItem.variant === 'confirm'`; ordinary questions keep their existing options and free-text answer path. Render a `role="group"` with the heading `Allow Aside to do this action?`, the concrete action, and its bounded detail/artifact preview.

For an answerable pending mobile approval, show full-width Allow and Deny rows, plus a first-class custom textarea labelled `Tell Aside what to do instead` with its own submit action. Deny offers an optional reason. Empty custom text cannot submit; choosing custom means decline the proposed action and send the alternative instruction, never implicitly allow it. On failure, retain the reason/custom text and permit retry. Settled/history cards display the recorded outcome without live controls.

Do not show numbered choices on phones: §8.4 and §8.8 supersede §7 item 9's desktop numbering. No window-wide shortcut handler is needed. Rows are at least 48 px tall.

Extend the mobile answer contract with structured `questionId`, `choice: allow | deny | custom`, optional `reason`/`instruction`, and a scoped remember value. Validate that the identified question is still the pending answerable confirmation. Preserve the existing header/label contract for ordinary questions. Atomically reserve a pending confirmation before dispatch so concurrent clients cannot answer it twice; retain an accepted reservation until the transcript records settlement, and release it only on a known pre-dispatch failure. Reject stale/double submissions rather than approve whatever question is newest. Persist/record the answer through the supported bridge flow, and include explicit deny/reason/custom semantics in the follow-up prompt.

The research's native optional `error` parameter belongs to the desktop mutation. The bridge cannot invoke it: mobile approvals are ordinary follow-ups; native suspended cards remain read-only with the existing explicit recovery action. Do not make an Allow-looking button silently create a replacement session. Recovery must remain labelled `Continue in a new session`.

### Remembering an action: capability-dependent part of this item

Display `Do not ask again for this action` only with an honest scope note. A working checkbox requires a verified structured action identity: operation, tool/action class, and relevant target scope, not an assistant-generated label or free-text similarity. Grants are limited to this session and that exact action scope, revoke when Ask first is explicitly re-enabled, and cannot override file permissions or mandatory platform approvals. Record a grant only after a successful Allow submission; Deny/custom never create one.

For a card with verified identity, default the checkbox checked, as the reference does, and show the scope before Allow. Until that identity and its matching mechanism exist, show the checkbox disabled and unchecked with `Remembering this action is not available from mobile yet.` Current `Action:`/`Details:` markers and `QuestionItem` do not supply that identity. Do not treat disabling it as completion of the remembered-approval requirement.

Any remembered behavior implemented through the soft prompt protocol must be described as an instruction to the agent, not an enforced security guarantee. Store bridge-owned grants outside the repository with the same privacy/bounds conventions as session preferences. Do not write native permission templates or `state.db`.

**Acceptance:** Allow, Deny with/without a reason, and a custom alternative deliver distinct recorded outcomes to the intended pending card. A failed submission retains text; a double or stale submission dispatches no second approval. Native cards remain unanswerable on mobile and recovery remains explicit. A remembered exact scope can affect a repeated match but cannot affect another recipient/path/session; unavailable identity cannot create a broad grant. Re-enabling Ask first revokes the session grants.

## P1-5: Gate image attachments on model support

Carry the existing parsed `DesktopModel.vision` to catalog/wire `supportsVision`. Preserve unknown capability when catalogs contain only ids; current fallback `vision: false` must not be misrepresented as a verified denial. Do not infer support from a provider name, model label, or the existence of an upload.

When a draft has an image attachment, filter the model picker to models declaring image support. Explain the filter inline. If the current/effective model is unsupported or unknown, retain it visibly, block send, and show `Choose a model that supports images to send this attachment.` Do not silently switch models. If filtering plus search yields no rows, explain whether no image-capable models are available or the search has no match. Removing the last image restores ordinary choices.

Repeat validation on the server against resolved upload-receipt metadata and the effective model, including omitted-model requests resolved to the account default. Apply it to new sessions, follow-ups, and recovery dispatch. Reject incompatible/unknown image requests before spawning. Documents and video files are not classified as image inputs solely because they share the media menu.

**Acceptance:** Vision true/false/unknown survives catalog construction, config overlays, and client serialisation without credential fields. Image drafts only offer verified supporting models. Direct API calls, stale clients, and unresolved defaults cannot bypass the check. Removing an image unblocks a valid text-only send. Upload and catalog refresh races preserve the draft and provide an actionable error.

## P1-6: Add an effective Follow-up behavior preference

Add `followUpBehavior: 'queue' | 'steer'` to `MiniappSettings`, default `queue`. Normalise absent/invalid persisted values to Queue; reject invalid API patches and preserve unrelated settings. Persist in the existing Mini App preference store, never Aside's account-wide settings or the Python bridge's config.

Use the verified shipping copy:

| Element | Text |
|---|---|
| Title | Follow-up behavior |
| Description | Queue follow-ups while Aside runs or steer the current run. |
| Choices | Queue; Steer |

The title, description, and values were additionally read on 2026-09-29 from shipped `agents-DbIiE33D.js`; the discovery copy also appears in `route-C-N4akVn.js`. This is local read-only evidence, not a new API contract.

Resolve the preference on the server at submission time and capture it with the request. Idle sends use the normal continuation path. Busy Queue sends retain the existing FIFO/batching. Busy Steer sends invoke the supported CLI `aside session steer <id> -- <prompt>` through a shared dispatcher, carrying the existing mobile reminder and receipt-backed attachment references. Verify positional `--` support before shipping this argv shape. Do not route a steer request through `session resume` or both transports.

Serialise steering against turn completion and other controls. If the run ends before steering begins, dispatch one normal continuation. A steer operation must not make the existing driver appear finished until it actually settles; preserve transcript streaming and one active execution owner. Existing queued requests retain order and enter a paused state after a successful interruption; expose the paused count and an explicit Resume queued messages action so they cannot restart unexpectedly or become stranded. This compact status/resume control is required in P1; the editable list comes in P2.

Do not offer Steer as working until the installed CLI/driver interaction is verified. On unsupported installs, keep Queue effective and show Steer disabled with an inline reason. A failed or timed-out steer keeps the user's request available for retry and does not silently queue it or retry it after an ambiguous acknowledgement. There is no per-send queue/steer menu.

**Acceptance:** Queue is effective after first install, reload, and malformed persisted input. Idle behavior is identical under either preference. Busy Queue dispatch remains FIFO; Busy Steer calls the steering CLI once and retains active-stream truth. Completion races dispatch the message exactly once, and queued work pauses/resumes explicitly. Unsupported transport disables Steer rather than saving a no-op setting. A settings change cannot alter already accepted requests.

**Scope decision:** Saving a preference alone does not complete item 11. A real Mini App steering dispatcher is its necessary dependency. P2 adds the Telegram `/steer` and explicit running-thread action, rather than implementing another dispatcher. The setting is Mini App/PWA-local; it does not silently change ordinary Telegram text behavior.

## Shared constraints and verification

Use the existing adaptive picker below/above 640 px, tokens, Lucide and provider marks, and two-tier composer. Keep visible labels. All taps have at least 44 × 44 CSS px hit areas; attach/send/stop have 48 × 48; picker/approval rows have 48 px minimum height. Composer pills can look 32 px high while retaining a 44 px hit area and at least 8 px between adjacent controls. Wrap the row when needed rather than collapsing state to icons. Decorative glyphs are hidden from accessibility; controls carry names and expanded state.

All new/mutated APIs retain the current owner authentication and cookie-origin protections. Prompt text remains a positional argv argument. Session and question ids are validated; no unrestricted client path, credentials, raw catalog transport fields, or private daemon endpoint is added. Keep unknown state explicit, errors retryable, and permission/recovery boundaries intact.

Implement the controls, project context, attachments, and vision validation independently; build approval and steering contracts before their interactive UI. Add focused tests for observable state transitions, API bypasses, stale questions, per-thread project isolation, and dispatch races. Before runtime changes ship, independently review the approval authority and steering lifecycle; this is more than a cosmetic tier despite the research heading.

Run workspace typecheck, isolated tests (`MINIAPP_PORT=8792 MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0 npm test`), and build. Inspect light/dark layouts at 320, 375, 390, 430, and 768 px, with long names, keyboard occlusion, 200% text zoom, reduced motion, focus, and busy/blocked/error states. A browser check does not prove Telegram's picker or a real CLI interruption.

**Non-goals:** native final-confirm replies, private tRPC, native project membership/creation, new fonts/icon systems, live-tab mentions, folder attachment, dictation/incognito, provider authentication UI, account-wide preference writes, Python follow-up preference changes, queued-message editing or Fast mode.

**Remaining gates:** exact action identity and scoped soft-grant matching for remembered approvals; real steering/driver settlement and positional prompt handling; catalog records with enough capability data; video-picker behavior on a device. The rest of the tier can proceed while individual unsupported capabilities remain honestly disabled. Those disabled capabilities must be reported as incomplete, not parity achieved.
