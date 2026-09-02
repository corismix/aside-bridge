# The bricked-session failure, and the four holes that let it through

A real user started a session from their phone. It got suspended on a
native `ask_user_question` call, the Mini App showed a read-only banner
saying the question could only be answered from Aside on their computer,
and the session was over. Nothing could revive it.

This note is what that failure actually was, why the existing mitigation
did not cover it, and what each surface does now.

## The root cause, which has not changed

`ask_user_question` and `request_action_confirmation` suspend the session
until the answer arrives over the daemon's **own authenticated channel**,
and that channel is the Aside desktop sidepanel. From a phone there is no
path to it. Checked against the live CLI, in every form there is:

- a follow-up `aside exec --session <id> "<text>"` blocks indefinitely,
  whether or not the process that started the turn is still alive;
- writing to the driver's stdin does nothing;
- the `aside.sessions` repl facade has no answer or respond method at all
  (its whole surface is constructor, current, list, get, messages,
  messageRows, childSessions, update, archive, unarchive, markRead,
  markUnread).

So a session parked on one of those tools cannot be answered, cannot be
cancelled into a usable state, and cannot be resumed. **Prevention is the
only real fix.** Everything below is prevention, except the last part,
which is a way sideways once prevention has already failed.

## Gap 1 — bridge.py never got the instruction

The Mini App prepends an instruction block to the first message of every
session it starts (`miniapp/server/src/preamble.ts`). The Python chat
bridge did not. Its persona presets covered the `[[APPROVAL]]` protocol
and nothing else, so a session started by texting the bot had **zero**
protection — and when opened in the Mini App it showed the dead banner.

**Now:** both style presets (`casual` and `formal`) tell the agent never
to call either native tool, and define the `[[QUESTION]]` block —
the same JSON shape `miniapp/server/src/questions.ts` already parses, so
the two transports speak one protocol. `bridge.py` parses the block, turns
its options into an inline keyboard, and injects the tapped label as the
next turn. Where the option list is empty it is a plain question and an
ordinary reply answers it.

`[[APPROVAL]]` is untouched and still takes precedence when a turn
contains both: it is the narrower ask and the older protocol.

If the agent calls a native tool anyway, the bridge now says so for
`ask_user_question` as well as `request_action_confirmation`, names what
was asked, and points at the desktop or at `/new`.

## Gap 2 — the daemon's final-confirm mode mandates the fatal tool

With `runtimeConfig.finalConfirm` on, the daemon injects a **SYSTEM-level**
instruction requiring `request_action_confirmation` before external
actions. That outranks a first-message preamble. A session with it on
bricks the first time the agent touches anything outside the machine — and
the flag is inherited from the account default, so an owner who runs with
it on at their desk got it on their phone sessions too.

Worse, the Mini App had a switch labelled "Final confirm" that wrote it.
Turning on the safety feature was the thing that killed the session.

**Now:**

- Every session the Mini App creates gets `runtimeConfig.finalConfirm =
  false` written explicitly right after creation — not "left alone",
  because leaving it alone means inheriting it.
- `bridge.py` does the same in the same call that grants full access
  (`new_session_settings_expression`).
- The switch was renamed **"Confirm before acting"** and repurposed
  honestly. On a session driven from a phone it never writes the native
  flag; it sets a soft flag (`miniapp/server/src/softconfirm.ts`) that adds
  a stronger line to the preamble and to every follow-up reminder,
  requiring a `[[QUESTION]]` confirm before anything external or
  irreversible. On a session started at the desk, where the sidepanel
  exists to answer it, the switch keeps its original meaning.
- A session is recognised as phone-driven from the seed text in its own
  first message — the Mini App preamble or bridge.py's persona line — so
  there is no store to keep in sync and nothing to lose on a restart.

One case is deliberately left alone: `/sessions` in the chat bridge can
switch onto a session started on the desktop, and that session's own
`finalConfirm` is not touched. It is not a session these surfaces created,
and silently rewriting the settings of the owner's desktop work is worse
than the risk. The per-message reminder still rides on every turn sent into
it, which is the cover.

**Bootstrap ordering.** `runtimeConfig` still only binds on the next `aside
exec` spawn, and the CLI has no create-time flag for it. The Mini App now
uses an intentionally empty, low-effort bootstrap turn carrying only the
mobile preamble; it waits for that turn to finish, writes
`finalConfirm: false`, then submits the user's real request as the next
turn. That removes the inherited-final-confirm race instead of treating the
preamble as its only cover.

## Gap 3 — compaction eats the instruction

The preamble rode on the first message only. Long sessions get compacted,
and a protocol note is exactly the sort of housekeeping a summariser drops.
Low-effort and non-Claude models drift back to the system prompt's default
of calling `ask_user_question` sooner still. Either way the session bricks
on the next question.

**Now:** one short bracketed line is appended to **every** follow-up
message from both surfaces:

```
[Reminder: mobile session -- never call ask_user_question or
request_action_confirmation; ask with a [[QUESTION]] {json}
[[/QUESTION]] block and end the turn.]
```

It is byte-identical on both sides, so a session started by texting the bot
strips cleanly when it is read in the Mini App.

Every-message rather than every-Nth on purpose: a throttle saves a few
dozen tokens a turn and pays for it with a failure mode that only appears
on exactly the long sessions the throttle was meant to help. The marker,
native-tool names, example JSON and base reminder live in
`miniapp/server/src/mobile-policy.json`, which both the Python bridge and
the Mini App consume; only the Python bridge's small presentation-style
reminder remains transport-specific.

It is **appended**, not prepended, so:

- it composes with the attachment header, which is prepended;
- it never makes the prompt dash-leading, which is the argv bug the `--`
  terminator exists for (see `PROMPT_TERMINATOR` in
  `miniapp/server/src/exec.ts`);
- a question answer still leads with `Header: Label`.

It is stripped back out everywhere the user's own text is displayed:
thread bubbles, session-list titles and previews, on both surfaces
(`stripAgentDirectives` in `preamble.ts`, `strip_agent_directives` in
`bridge.py`). While fixing that, the Mini App preamble turned out to be
leaking into session-list titles — it is prepended *before* the attachment
header, so the header-splitter never matched. Both come off now.

## Gap 4 — a bricked session was a dead end

The banner was honest and useless.

**Now:** a pending native question offers **"Continue in a new session"**,
and its options become tappable again — as the seed of a new session, not
as an answer to the dead one. `POST /api/sessions/:id/recover` reads the
pending question out of the transcript itself (never from the request
body — what the new session is told the old one asked has to be true),
builds a short preface with the question, the options, the tapped answer
and the stuck session's own opening message, and starts a new session
carrying the full preamble.

It is a preface, not a replay: copying the whole transcript would spend
most of a fresh context window reproducing a conversation the agent can
simply be told about. The stuck session is left byte-for-byte as it was,
because nothing can change it.

## Where to look

| Concern | File |
|---|---|
| Preamble, strict variant, follow-up reminder, stripping | `miniapp/server/src/preamble.ts` |
| Question parsing, recovery seed | `miniapp/server/src/questions.ts` |
| Soft confirm-before-acting store | `miniapp/server/src/softconfirm.ts` |
| Create / send / answer / permission / recover routes | `miniapp/server/src/app.ts` |
| Phone-driven session detection, list titles | `miniapp/server/src/sessions.ts` |
| The card and its recovery affordance | `miniapp/web/src/components/QuestionCard.tsx` |
| Chat presets, question gate, new-session settings | `bridge.py` |

Tests: `miniapp/server/test/native-questions.test.ts`,
`miniapp/web/test/native-questions.test.tsx`,
`tests/test_question_gate.py`. The `[[APPROVAL]]` flow keeps its own
suites (`tests/test_approval_gate.py`,
`tests/test_approval_persistence.py`) and they are unchanged.
