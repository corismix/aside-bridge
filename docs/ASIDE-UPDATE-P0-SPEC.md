# P0 specification: Aside update foundations

**Status:** Draft for implementation; no runtime changes authorised by this document.  
**Date:** 2026-09-29.  
**Source:** [Aside update research](ASIDE-UPDATE-RESEARCH-2026-09-29.md), §7 items 1–5.  
**Reference versions:** Aside Browser `1.0.928.1`, agent `1.26.928.1922`, CLI `1.26.916.1741`, as recorded in the research.  
**Next tiers:** [P1](ASIDE-UPDATE-P1-SPEC.md), [P2](ASIDE-UPDATE-P2-SPEC.md).

## Outcome and scope

Restore supported Max effort, make both composer placeholders consistent, let the Telegram owner stop the active task, and correct the permission and transport documentation. Preserve the existing CLI/facade architecture, mobile confirmation protocol, and two-tier composer.

This specification uses the working tree inspected on 2026-09-29, including existing uncommitted picker changes. Source anchors below are file/symbol references; research line numbers are historical.

| Research item | Requirement | Primary implementation surface |
|---|---|---|
| 1 | P0-1: Max effort | `miniapp/server/src/config.ts`, `desktop.ts`, `catalog.ts`, `exec.ts`; web effort types/picker |
| 2 | P0-2: Composer copy | `miniapp/web/src/components/Composer.tsx` |
| 3 | P0-3: Telegram stop | `bridge.py`: `handle_command`, `handle_message`, `worker_loop`, `run_aside` |
| 4 | P0-4: Documentation | `docs/MINIAPP.md`, `docs/ASIDE-DESIGN.md` |
| 5 | P0-5: Permission descriptions | `miniapp/web/src/components/Pickers.tsx` |

## P0-1: Restore Max without claiming every model supports it

1. Add `max` between `xhigh` and `ultrabrowse` in both `EFFORT_LEVELS` and `EFFORT_MENU`. Keep `max → Max` and the existing acceptance of Off and Minimal. Remove both stale claims that the CLI rejects Max, including the reference to the nonexistent `SENDABLE_EFFORT_LEVELS`.
2. Document the dated, non-billed validation probes from research §10.1. They establish CLI argument acceptance; they do not establish the daemon's effective effort for a model.
3. Carry a model's verified `availableThinkingLevels` from the existing read-only catalog sources through the server catalog and client types. Preserve missing metadata as unknown rather than inventing a list. Expose Max only when the selected model explicitly declares `max`; intersect declared levels with the CLI-supported enum for the ordinary effort choices. Preserve Ultrabrowse's current disabled treatment until P2-6.
4. Accept and retain `max` in configuration and preferences. Before dispatch, reject an explicit Max request for a model that does not declare support, including an unresolved account-default model. Return an actionable error and keep the draft. Do not silently convert Max to Extra High or claim a different effort ran. Existing non-Max behavior for catalogs without capability metadata remains compatible.
5. When changing models invalidates the selected effort, require a supported choice and explain it. Do not silently execute a saved Max preference against a different model.

**Acceptance:** A supporting-model fixture offers Max, persists it, and puts the literal `max` in new-session and continuation argv. An unsupported or unknown-model fixture never offers Max and cannot bypass validation through a direct API request. Invalid effort strings remain rejected; existing Off/Minimal acceptance and Ultrabrowse disabling remain intact. A CLI validation error is visible rather than relabelled as successful execution.

**Boundary:** The minimal thinking-level plumbing belongs here because research §10.1 explicitly limits Max to declaring models. The richer vision and speed capabilities belong to P1/P2. If current local catalogs do not expose thinking levels, enum support can land, but the selectable-Max acceptance check remains blocked until a verified source exists. Do not introduce private tRPC to satisfy it.

## P0-2: Use one composer placeholder

Set the home and reply textarea placeholder to exactly `Ask Aside...`, with three ASCII periods. Keep the controlled draft, attachment handling, textarea growth, and submission rules unchanged. Do not add `@ for context` or a browser-tab mention affordance.

**Acceptance:** Both variants render that exact string. Typing, multiline input, ready attachments, blocked sessions, and send/stop controls retain their existing behavior.

## P0-3: Add `/stop` to Telegram

1. Recognise `/stop` and `/stop@<bot-name>` through the existing owner-authorised command path. It accepts no session argument and acts on the bridge's active run. Source help must say it also cancels waiting messages; those original Telegram messages remain in chat. Publishing a Telegram command menu is outside this source change.
2. Handle the command outside the turn worker queue so it works while `run_aside` is waiting. Snapshot the active run's session id independently of the selectable `state["session_id"]`; a concurrent session switch must not redirect Stop to another task. During bootstrap without a known run id, report that stopping is not yet available.
3. Invoke the configured executable with an argv array equivalent to `aside session stop <id>`, a bounded timeout, and no shell. Keep `_reap_stale_exec` for startup orphan cleanup. Do not reuse pattern-based process killing as the command implementation.
4. On successful stop acknowledgement, prevent queued plain-message tasks already waiting behind that run from immediately restarting work. Cancel those waiting messages, report their count, and preserve queued commands such as `/new` and `/usage`. Serialise cancellation with queue consumption so a just-dequeued message cannot escape. Messages arriving after the stop acknowledgement are new requests and may run normally.
5. Coordinate the active run's exit with the stop result. Preserve partial transcript output, clear its restart-replay `pending` value once cancellation is confirmed, and report a stopped task without expiry recovery or a generic failure. Never replay the stopped prompt after a restart. A failed/timed-out stop does not discard waiting messages or claim the task stopped.

**Acceptance:** With a fake long-running driver, `/stop` reaches the stop CLI before that driver completes. Successful stop causes no queued follow-up spawn, retains partial output, preserves queued commands, and prevents restart replay. Idle/no-session use reports nothing is running without creating a session. Repeated taps, session switching, a naturally finishing run, CLI failure, and stop timeout neither target another session nor clear unrelated state. A non-owner update cannot invoke the command.

**Runtime gate:** Research verified command availability, not its interaction with a bridge-owned child. Before considering this item complete, exercise a throwaway active session and establish that the CLI driver settles and local busy state clears. If the daemon stops but the driver remains stuck, resolve that lifecycle explicitly; do not ship a permanently busy bridge or a pattern-kill fallback.

## P0-4: Correct the docs to match the implementation

Update the transport examples in `MINIAPP.md` to the actual two spawn shapes:

```text
aside exec [-m <provider/model>] --effort <level> -- <text>
aside [-m <provider/model>] --effort <level> session resume <id> -- <text>
```

The model option is omitted when unresolved; `--` is required for dash-leading prompts. Do not rewrite the continuation path as `exec` first: `exec.ts` currently puts the global options before `session resume`. Describe the existing Mini App Stop separately from the new Telegram command; P0 does not replace the Mini App's owned-child stopping mechanism.

Re-pin `ASIDE-DESIGN.md` to the reference browser/agent versions above and record the CLI version separately. Include both the versioned `Libraries/AsideAgentManager` path from research §1.1 and the `Versions/Current` form for future read-only inspection. Use current verified asset names, including `globals-d32IVJ-N.css`, with a note that hashed filenames change.

Include this re-verification procedure, with each command independently runnable after the path assignment:

```bash
ASIDE_AGENT_DIR="/Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/Current/Libraries/AsideAgentManager"
```

```bash
rg -l 'Ask Aside' "$ASIDE_AGENT_DIR" -g '*.js'
```

```bash
head -5 "$ASIDE_AGENT_DIR/manifest.json"
```

The current design document already contains an older on-disk path and does not contain the claimed extraction prohibition. Update what is actually present; delete an obsolete “cannot re-extract” claim only if one exists at implementation time. Preserve the restriction against copying compiled bundles or proprietary fonts into the repository. Existing token values need no rewrite.

**Acceptance:** Examples agree with both `exec.ts` spawn sites. Dates, versions, source path, and asset examples agree with the cited research. Read-only re-verification works on the reference install or clearly reports a missing install. No live task, settings write, or asset extraction is required for the doc check.

## P0-5: Use Aside's permission descriptions honestly

Use these exact descriptions inline, retaining the existing labels and enum values:

| Mode | Label | Description |
|---|---|---|
| `read-only` | Read only | Can only work in this task’s folder. Won’t access other folders. |
| `guard` | Guard | Can work in Documents, Downloads, and this task’s folder. Asks before accessing other folders. |
| `full-access` | Full access | Can read and write anywhere on this computer. |

Add `Aside's default is Guard.` as explanatory sheet text. The selected check and composer state must continue to come from the actual session or explicit draft preference. An unreadable session mode stays unknown; the default sentence must not manufacture a Guard state. Existing stored/inherited modes are not overwritten by a copy change.

Preserve the explanation that mobile confirmation uses answerable cards and applies from the next message. Do not turn on native `runtimeConfig.finalConfirm` for mobile sessions. Do not infer that `read-only` cannot take any action merely from its name; the shipped description concerns folder access.

**Acceptance:** All three descriptions and the default sentence are visible without hover. Actual Full access still appears selected when active; unknown state does not become Guard. Copy changes cause no permission or confirmation write.

## Delivery and verification

Implement in order: Max enum/capability validation, composer/permission copy, Telegram Stop, documentation. Use focused catalog/config/runner, composer/picker, and offline Python command regressions. Run affected Python scripts directly; use temporary test configuration without overwriting an existing `config.json`.

For shared Mini App changes, run typecheck, the full isolated workspace tests, and build from `miniapp/`. Keep tunnel and menu registration disabled in tests:

```bash
MINIAPP_PORT=8792 MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0 npm test
```

Visually inspect light/dark home and reply states at 320, 390, and 430 CSS px, including permission descriptions and keyboard occlusion. Report browser evidence separately from real Telegram/PWA and live CLI evidence. The draft itself requires document/link/source review, not execution of runtime tests.

**Non-goals:** permission policy redesign; native final-confirm answering; daemon tRPC; native project membership; Fast mode; queue editing; changing tunnels, launchd, account settings, or the startup orphan reaper; unrelated working-tree edits.

**Remaining uncertainty:** CLI acceptance of Max is established by the research, effective daemon effort is not. Thinking-level metadata may be absent from available catalog records. Stop/driver lifecycle needs a controlled live check. None of those gaps authorises a billed turn or changes to the live service during specification drafting.
