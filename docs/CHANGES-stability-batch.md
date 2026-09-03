# Stability batch — what changed

Eight fixes plus real brand marks and a docs tidy-up, all inside
`miniapp/`, `docs/` and `README.md`, with one small addition to
`bridge.py`. Nothing was committed or pushed. The live `com.aside.miniapp`
service and the live Python bridge were never touched; the one smoke run
used port 8799 with `MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0` and
was killed by its own PID.

**Tests:** 420 server + 127 web, all passing. 90 of those are new
(`server/test/stability.test.ts`, `server/test/stability-api.test.ts`,
`web/test/stability.test.tsx`). `npm run typecheck` and `npm run build`
green in both workspaces.

---

## 0. Fix round, after live browser E2E

Everything below was exercised end-to-end in a browser against real
sessions. One real bug surfaced, and it is the one worth reading first.

**Tapping a question option sent the answer, and the follow-up turn died**
with exit code 1 and `error: unknown option '- Color test: Red'`.

The prompt is a **positional** argument, and the CLI's parser treats any
dash-leading token as a flag wherever it appears — so `answerMessage`'s
bulleted `- <header>: <label>` form never reached the agent at all. This
was never specific to question answers: a hand-typed message starting with
`-` failed identically.

Reproduced and fixed against the real binary:

```
$ aside session resume X ... "Color test: Red"       → Session not found   (parses)
$ aside session resume X ... "- Color test: Red"     → unknown option      (the bug)
$ aside session resume X ... -- "- Color test: Red"  → Session not found   (fixed)
```

Two changes, belt and braces:

- **`PROMPT_TERMINATOR`** (`--`) is now sent immediately before the prompt
  at **both** spawn sites in `exec.ts` — continuation turns and new
  sessions. This is the actual fix, and it covers hand-typed messages too.
  Note it is *not* a shell-injection guard: args already go as an argv
  array, never a shell string. It is purely the CLI's own parser.
- **`answerMessage` no longer leads with a dash** (`<header>: <label>`),
  which also reads better in the transcript. The client-side optimistic
  echo in `App.tsx` was duplicating that format and is now aligned —
  `pendingIsEchoed` matches the bubble against what the transcript ends up
  holding, so a drifted format would have left a ghost bubble for the full
  two-minute TTL.

Regression tests assert `--` sits immediately before the prompt at both
spawn sites, that batched messages stay one argument behind one terminator,
and that an answer never leads with a dash. Two pre-existing `exec.test.ts`
argv assertions were updated for the new argument.

---

## 1. Settings

`SettingsScreen.tsx`, reached from the model picker's Settings row — which
previously closed the popover and did nothing.

Sections follow Aside's own settings pages: small uppercase heading, rows
with a title + description on the left and the control on the right,
hairline dividers, a footnote where scope needs stating.

- **New sessions** — default model, reasoning effort, permission mode,
  final-confirm. These actually apply: `POST /api/sessions/new` consults
  them, and an explicit pick on the composer always wins.
- **Aside account** — the account's own default model and effort, read-only.
- **Appearance / Connection** — theme (follows Telegram), daemon
  reachability, bridge presence, tunnel mode and URL, version.

Stored server-side in `miniapp-settings.json` (0600, beside the bridge
config), never in Aside's global settings.

**Judgment call:** the permission default ships as `null` — "leave the
daemon's own default alone" — and the env gate `MINIAPP_GRANT_FULL_ACCESS`
is untouched. A settings row must not become a second, quieter way to widen
permissions. Choosing `full-access` there is an explicit act and is
recorded as one.

## 2. Questions and approvals

The bug: `ask_user_question` rendered as a raw JSON blob under a "Success"
badge, and the driver process hung forever while the session sat
`suspended`.

Established today and not re-derived: **there is no way to answer a pending
native question from anywhere but the desktop sidepanel.** Follow-up
`aside session resume` blocks indefinitely, stdin to the driver does
nothing, and the `aside.sessions` facade has no answer method.

So, three parts:

- **`questions.ts` + `QuestionCard.tsx`** — both `ask_user_question` and
  `request_action_confirmation` become a card with a header, the question,
  tappable options carrying label + description, a free-text reply, and a
  flattened artifact summary for confirmations. Answered questions settle
  into history showing the choice.
- **Prevention at the source** — `preamble.ts` prepends an instruction
  block to the first prompt of every session this app starts: never call
  those two tools, emit `[[QUESTION]] {json}` and end the turn instead.
  That block renders as the same card with *working* buttons, because a
  reply is then just a follow-up message. It is a superset of bridge.py's
  `[[APPROVAL]]` protocol, which is still parsed verbatim. The preamble is
  stripped for display, like the attachment header.
- **Honest dead end for desktop-created sessions** — a pending native
  question renders read-only with "Respond from Aside on your computer",
  and `POST /send` / `POST /answer` return 409 `session_suspended` rather
  than queueing a turn that would hang.

**Driver hygiene:** `TurnRunner` now polls the session's status while a turn
runs (`WATCHDOG_INTERVAL_MS`, 2s) and, on `suspended`, reaps its own child
by PID and emits `turn_finished { suspended: true }`. The fold settles and
the question card appears instead of an infinite spinner. Kills are always
SIGTERM-then-SIGKILL **by PID** — never by command-line pattern, since the
live service shares the same invocation.

## 3. Error messages

Provider failures live on an assistant record with `stopReason: "error"`, an
`errorMessage`, and an **empty** `content` array — so a builder that only
reads `content` renders a blank response. That was the bug.

`errors.ts` reproduces Aside's own classification ladder (transcribed from
`error-alert-*.js`), including the JSON-envelope parse: rate limit, provider
outage, expired sign-in, out of credits, disk full, generic. `ErrorCard.tsx`
draws the shipped card — warning glyph, bold title, muted description,
`Details` revealing the raw message. Covered: model rate limits, generic
turn failures, and CLI non-zero exits (stderr tail behind Details).

**bridge.py:** the cheap-fix condition was met. Added `read_error_since()`
alongside the existing `read_assistant_since()`, and the chat-mode fallback
now says "the model provider refused that turn: …" instead of "done, but no
text came back. odd. check the mac?" ~30 lines, same file, same style.

## 4. Work fold auto-expand

Two real bugs, both fixed and both regression-tested.

- **Fold identity.** Work and answer ids were positional
  (`work-${items.length}`). A turn's trailing text is promoted to an
  `answer` item when it is last and demoted back into the fold the moment
  another tool call arrives — constantly, mid-turn. Every flip renumbered
  every later item, React saw new keys, and every fold on screen remounted,
  discarding the reader's own expand/collapse choice. Ids are now derived
  from the turn's opening message index, so a fold keeps one identity for
  as long as the turn exists.
- **Commentary vs. the answer.** `foldIsLive` collapsed on *any* streaming
  text. But agents narrate mid-turn, between tool calls — so the timeline
  slammed shut on every paragraph and flapped open on the next tool call.
  The new rule: streaming text while a step is still pending is commentary
  (stay open); streaming text with every step settled is the answer
  (collapse). A real `answer` item or a question also ends it.

The manual toggle still wins for the life of the fold, and now actually
survives, because the component no longer remounts underneath it.

## 5. Streaming footer

`threadStats.turnStartedAt` came from the first *assistant* record, which on
a slow model is tens of seconds after send — and until then it was `null`,
so the footer did not render at all. It is now the **user** message's
timestamp. The footer also renders on `busy` alone rather than requiring a
start time, and falls back to its own mount clock; the token count reads `—`
until it is known rather than claiming `0 tokens` mid-turn.

Uses the real Aside brand symbol.

## 6. Stop

`POST /api/sessions/:id/stop` → `TurnRunner.stop()` → SIGTERM the driver
child by PID, SIGKILL after `STOP_GRACE_MS` (3s). Anything queued behind it
is dropped — someone who taps Stop wants the agent to stop, not to watch the
next queued prompt start. 409 `not_running` when there is nothing to stop.

UI: a small dark rounded square to the **left** of send while a turn
streams, matching the desktop composer; optimistic "stopping" state; the
turn is reported `stopped: true` and raises no error card, because a
deliberate stop is not a failure.

Steering was not attempted. It is not possible through the CLI.

## 7. Task list

`todos.ts` replays `write_todos` calls in order with exact merge semantics —
`merge: false` replaces, `merge: true` merges by id keeping position and
leaving unmentioned items alone (a real merge call names only what
changed, which is what a "last call wins" read gets wrong). Absent `merge`
defaults to a full write; a call without ids keys on content.

UI: `TodoSection` sits on top of the composer, **collapsed by default** —
one row naming the in-progress item plus a `done/total` count and a chevron;
expanded, the full checklist with the status circles from the screenshots
(empty ring, part-green spinner, filled green check, struck-through dimmed).
`TodoProgress` renders the same list as "Task progress" at the bottom of the
session panel.

Its open state is purely manual and has no interaction with (4).

## 8. Real brand marks

`web/src/components/Brand.tsx` — real SVG path data transcribed from the
shipped bundle and rewritten as our own components, `currentColor`
throughout, sized by prop, 24-unit viewBox like Aside's:

| provider | source chunk |
|---|---|
| Aside brand symbol | `official-brand-symbol-BYTWU1T8.js` |
| OpenAI (`openai`, `openai-codex`) | `openai-ybMOGuI6.js` |
| Claude (`claude-code`) | `claudeai-QU_EMgNc.js` |
| Anthropic | `icons-ZrCkM6K_.js` |
| Google | `google-DjLmleej.js` |
| xAI | `copilot-CUTpracs.js` |
| Grok (`xai-grok-oauth`) | `icons-ZrCkM6K_.js` |
| fallback cluster | `icons-ZrCkM6K_.js` |

**Cerebras:** the bundle carries the display name "Cerebras AI" but ships no
icon — it falls through to the generic cluster glyph in Aside's own map. We
do the same, which is more faithful than inventing a mark. No press-kit
fallback was needed.

The Aside symbol is now used for the streaming footer, the settings header
and the Aside provider row. The model pill and subagent card carry the
running provider's real mark instead of a hand-drawn asterisk. The old fakes
(`ModelMark`, `AsideMark`, the four-dot `ProviderMark`) are gone. No fonts,
no webp, no non-SVG assets copied.

## 9. Documentation

- **New `docs/MINIAPP.md`** — one "How it works" (four paragraphs plus an
  ASCII diagram) and one "Setup" (prereqs → install → configure → run →
  second-instance kill-switches → development), plus the full Limitations
  list updated with today's facts: native pending questions cannot be
  answered from mobile and the soft protocol is used instead; stop is
  supported, steering is not; Mini App settings are the Mini App's own.
- **`README.md`** — Mini App section shortened, the duplicated limitations
  removed in favour of a pointer, the chat-bridge steering note clarified.
- **Deleted `docs/MINIAPP-REPORT.md`** (1768 lines). It was a chronological
  round-by-round build log with heavy duplication and stale content, and it
  is what "one clear How it works / one clear Setup" was competing with.
  **Flagging this explicitly** since it is the only deletion: it is in git
  history and trivially restorable if you want it back.
- `docs/AUDIT.md` untouched, as instructed.

---

## Sweep

- No secrets, tokens, absolute personal paths or user ids introduced. A test
  asserts `/api/status` leaks none of them.
- The one new persisted file (`miniapp-settings.json`) is written 0600 into
  the existing state directory, never the repo.
- Changes are confined to `miniapp/`, `docs/`, `README.md`, and the ~30-line
  `bridge.py` addition permitted by deliverable 3.

## Worth a second look

- The **preamble** rides on every new session's first prompt and competes
  with the user's message for attention. It is kept short, but it is a real
  behavioural change to how mobile-started sessions are primed.
- **Dropping the queue on Stop** is a choice, not a necessity. If you would
  rather queued messages survive a stop, it is a one-line change in
  `TurnRunner.stop()`.
- The **watchdog polls** `state.db` every 2s per running turn, invalidating
  the 5s row cache each time. Cheap (one indexed row read) but not free.
