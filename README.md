# aside-telegram-bridge

Text your [Aside](https://aside.so) browser agent from your phone.

Your full Aside agent -- tools, memory, everything -- living in a Telegram
chat. Ask it things, send it photos, give it multi-step tasks, watch live
progress fold into a tidy collapsible worklog when it's done.

## Install (2 minutes)

Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/SaiAmartya/aside-telegram-bridge/main/install.sh | bash
```

The setup wizard walks you through the rest:

1. It asks for a bot token -- message [@BotFather](https://t.me/botfather)
   in Telegram, send `/newbot`, copy the token it gives you.
2. You text your new bot once -- the wizard detects you automatically.
3. Pick a reply style. Done. The bridge installs itself as a background
   service and your bot answers from then on, even after reboots.

No dependencies, no pip installs, no webhooks, no ports. Plain Python that
ships with macOS, talking outbound to Telegram only.

Requirements: a Mac with [Aside](https://aside.so) installed, and a
Telegram account. The optional [Mini App](#the-mini-app) also needs
Node 20+.

## What it feels like

```
you:   what's on my plate today
aside: Three things: the 7pm walkthrough with Josh, SAT prep at
       9:30, and that email from Vercel you've been ignoring.

you:   handle the email
aside: On it.
       ⏳ working · 45s · 3 steps      <- one live status line
aside: Drafted a reply. Want to see it before I send?
```

- Replies come as short chat bubbles, plain text, no markdown walls.
- Long tasks: one ack, one live status line (elapsed time + current step),
  then the result. When it finishes, the status line collapses into a
  tap-to-expand worklog of everything it did.
- Subagents get their own live roster inside that status line: each
  spawned subagent shows as a row (running/done/failed, elapsed time,
  and a one-line snippet of its result once it finishes), so parallel
  or background research doesn't just disappear into a generic
  "subagent_wait" tool call. The full history (spawn -> wait -> result
  per subagent) is preserved in the tap-to-expand worklog too.
- Send a photo and the agent opens and looks at it.
- Messages sent mid-task queue politely and run next.

## Chat commands

| command | what it does |
|---|---|
| `/status` | model, session, busy/idle, queue (instant, even mid-task) |
| `/model sonnet\|fable\|opus` | switch model |
| `/effort` | pick thinking effort for the next message (inline buttons: off, minimal, low, medium, high, xhigh, ultrabrowse -- same levels as the aside browser) |
| `/effort <level>` | set it directly without the button menu |
| `/usage` | Claude subscription usage + context-window fill + cost |
| `/new` | fresh persona-primed session |
| `/sessions` | list recent Aside sessions, tap a button to switch into one |

## The Mini App

The chat is for texting your agent. The Mini App is for *watching* it work:
the full Aside UI, inside Telegram, on the phone you already have out.

Tap the **Aside** button next to the message box and you get:

- **Sessions** -- every Aside session on your Mac, including the ones
  started from the desktop app, with unread dots and live status.
- **Live transcripts** -- tool calls stream in as they happen, then fold
  into one `Worked for 7m 43s ›` row the moment the answer starts. Tap to
  reopen the whole timeline.
- **Subagents** -- each spawn gets a coloured creature and its own nested
  card with the model it's on, its brief, and its tool timeline ticking
  over live. Tap through to the child's own thread.
- **Citations** -- `[1]` chips in the answer open the source that backs
  them.
- **Files** -- what the agent wrote and what you sent, in a side panel;
  markdown and images render in place.
- **Control** -- permission mode, final-confirm, model and reasoning-effort
  pickers, all writing to the same daemon state the desktop app reads.
- **Context meter** -- how full the window is, and what this turn cost.
- **Attachments** -- pick photos or files from the phone; they land on disk
  and the agent opens them.

Setup is one prompt at the end of the wizard (or run it later):

```bash
python3 miniapp/setup-miniapp.py
```

It checks for Node 20+, builds the app, installs a launchd service
(`com.aside.miniapp`), starts a Cloudflare quick tunnel so Telegram can
reach it over HTTPS, and prints the URL.

**How auth works.** Telegram signs every Mini App launch with an HMAC over
your bot token; the server validates that signature, checks the user id
against the same one-person allowlist the bridge uses, and mints a 24-hour
JWT. Every API call and the WebSocket carry it. Nothing is exposed but that
one authenticated HTTP surface, bound to loopback and published through the
tunnel — no inbound ports, no database, no third-party service. The bot
token never leaves the process, and the tunnel binary is a pinned
cloudflared release verified against a SHA-256 vendored in this repo before
it is ever executed.

### Limitations

Read these before deciding it's broken.

- **Sessions you start from the Mini App (or the chat bridge) don't appear
  in the desktop Aside app.** They're created through the CLI, and the
  daemon marks CLI-created sessions ephemeral, which is exactly what the
  desktop chat list filters out. The other direction works completely:
  anything you start on the desktop is visible, continuable and watchable
  live from your phone. That is the useful direction, and it is the one
  this was built for.
- **No mid-turn steering.** Same as the chat bridge: the CLI drops prompts
  sent to a busy session, so a message you send mid-task queues and runs as
  the next turn.
- **Your Mac has to be awake and online.** The server and the tunnel run on
  it. Asleep is offline.
- **The tunnel URL changes on every restart.** Quick tunnels are ephemeral.
  The server re-registers the menu button at the new hostname each time it
  rotates, so it self-heals — but a link you saved goes stale. For a URL
  that never moves, set up a named Cloudflare tunnel with your own domain
  and point `miniapp` at it.
- **One bot, one Mini App.** The menu button is bot-wide, so a second
  machine using the same bot token takes the button away from the first.
  Make a second bot with @BotFather if you want two.
- **"Max" reasoning isn't sendable.** Aside's own UI offers it; the CLI
  rejects `--effort max`. The picker hides it rather than silently running
  something else and telling you it was Max.
- **No live browser view.** You can watch the agent's tool calls, not its
  tab.

## Managing it

Setup links a `bridgemon` command into `~/bin`. It manages both services:

- `bridgemon status` -- bridge and Mini App together: running state, pid,
  port, tunnel URL, last error, last log lines.
- `bridgemon watch` -- live timeline of everything the bridge and agent do,
  plus a one-key kill switch.
- `bridgemon update` -- pull the latest version, syntax-check, restart, and
  auto-rollback if anything looks broken. When the Mini App is installed it
  is rebuilt (`npm install && npm run build`) and restarted too, with the
  same snapshot-and-roll-back rule.
- `bridgemon miniapp start|stop|restart|logs` -- the Mini App on its own.
- `bridgemon logs` / `rollback` / `init` -- the rest.

To stop everything: `bridgemon watch --kill` and `bridgemon miniapp stop`.

## Security, the short version

- Your bot token is a credential. `config.json` is chmod 600 and gitignored.
- Hard allowlist: the bridge ignores every Telegram chat except yours.
  Strangers get silence.
- Bridge sessions run with full tool access so the agent can actually do
  things unattended -- understand what that means on your machine. Switch
  the grant to `guard` in `bridge.py` if you want confirmation-gated
  behavior.
- Kill switch always works, and messages sent while the bridge is down are
  recovered on restart.

<details>
<summary><b>Architecture</b> (for the curious)</summary>

```
Telegram  <--long poll-->  bridge.py (launchd daemon)  <--aside CLI-->  Aside agent
                            |  poller thread: getUpdates, commands, photos
                            |  worker thread: one turn at a time, batching
                            |  TurnStream: ack / status-fold / final routing
                            +--reads replies from the session's messages.jsonl
```

Three layers:

1. **Bridge daemon** (`bridge.py`): long-polls the Telegram Bot API
   (outbound only), shells out to the `aside` CLI, reads replies from the
   session transcript, streams them back as bubbles.
2. **Persona layer**: a persistent Aside session primed with a texting-mode
   persona (auto-created on first run, re-created via `/new`). Full agent,
   adapted voice.
3. **Proactive layer** (optional): an Aside routine that pushes a morning
   digest or alerts into the same chat via the Bot API. Prompt sketch: pull
   calendar + important unread email, read token/chat_id from
   `config.json`, POST 2-4 short plain-text messages to `sendMessage`,
   never print the token.

The reply source of truth is the session's `messages.jsonl`, not CLI
stdout, which stays clean when turns involve tool calls and thinking.

</details>

<details>
<summary><b>Status folding</b> (how the worklog collapse works)</summary>

Telegram can't collapse "thought for 4 mins" like a native UI, so the
bridge approximates it: narration and tool-call titles go into one
notification-silent message edited in place (elapsed timer + step count +
latest note). When the turn ends, that message is edited into a collapsed
`<blockquote expandable>` containing the full timestamped worklog -- tap
to expand, ignore otherwise. Chat history keeps: ack → questions/blockers
→ folded worklog → result. Anything that genuinely needs you (a decision,
an approval, a blocker) escapes the fold and pings for real.

</details>

<details>
<summary><b>Design limits</b> (read before filing issues)</summary>

- **No mid-turn steering.** Messages sent while the agent is working queue
  and run as the next turn; they never redirect the current one. We tested
  every path to real steering: the `aside` CLI silently drops prompts sent
  to a busy session, and Aside's daemon contains a full native Telegram
  channel system with a real steering queue -- but its delivery path
  doesn't call `steer()` yet and drops mid-turn messages. Until that
  ships, queueing is the honest behavior. (We ran the native system in
  production for an evening and reverted.)
- **Serial by design.** One turn at a time; adjacent messages batch.
- **macOS only** as written (launchd, Aside's file layout). The Telegram
  and transcript logic is portable if someone wants to PR Linux support.
- `/usage` reads Anthropic's OAuth usage endpoint via the claude-code
  token Aside stores locally; on other providers that section silently
  degrades and the rest still works.

</details>

<details>
<summary><b>Manual setup</b> (if you'd rather not pipe curl to bash)</summary>

```bash
git clone https://github.com/SaiAmartya/aside-telegram-bridge
cd aside-telegram-bridge
python3 setup.py
```

The wizard is the same either way. Fully manual (no wizard): copy
`config.example.json` to `config.json`, fill in `token` / `chat_id` /
`owner_name`, chmod 600 it, then install
`com.aside.telegram-bridge.plist` into `~/Library/LaunchAgents` with the
paths corrected, and `launchctl bootstrap gui/$(id -u) <plist>`.

Style: `config.json`'s `"style"` is `"formal"` (default) or `"casual"`;
you can fully override with your own `"persona_prompt"` / `"style_tag"`.
Persona changes take effect on the next `/new` since it's baked in at
session creation. `default_effort` (default `high`) sets the thinking
effort every normal turn runs at; use `/effort` in chat to bump a single
upcoming turn to any level (off through ultrabrowse).

</details>

<details>
<summary><b>Files</b></summary>

| file | purpose |
|---|---|
| `install.sh` | the one-line installer (clone/update + run wizard) |
| `setup.py` | interactive setup wizard |
| `bridge.py` | the daemon (poller + worker + streaming) |
| `bridgemon.py` | deploy/update/rollback CLI + `watch` |
| `monitor.py` | live monitor + kill switch (via `bridgemon watch`) |
| `config.example.json` | reference config |
| `com.aside.telegram-bridge.plist` | launchd template (manual installs) |
| `miniapp/` | the Telegram Mini App: Fastify server + React web app |
| `miniapp/setup-miniapp.py` | Mini App setup wizard (Node, build, service) |
| `docs/MINIAPP-REPORT.md` | how the Mini App was built and verified |
| `docs/AUDIT.md` | independent security/robustness audit of the Mini App |

</details>

## Credits

Designed, built, tested, and documented by an Aside agent, working as a
digital co-founder for [@SaiAmartya](https://github.com/SaiAmartya), who had
the good ideas, caught the UX regressions, and made the executive calls.
