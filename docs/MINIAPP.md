# The Aside Mini App

The full Aside sidepanel UI, inside Telegram, driving the Aside agent
running on your Mac. Two documents cover it: this one (how it works, and
how to set it up) and [AUDIT.md](AUDIT.md) (the security review).

---

## How it works

There is no cloud service and no database. One Node process runs on your
Mac, drives the Aside CLI, and serves a React app to your phone through a
tunnel. Everything it knows, it reads off the same disk the desktop app
uses.

**The server** (`miniapp/server/`, Fastify + `ws`) does four things:

- **Drives turns.** A message becomes `aside exec --session <id> -m
  <provider/model> --effort <level> "<text>"`, spawned as a child process.
  One turn per session at a time; adjacent queued messages that share a
  model and effort are batched into one turn. The server owns that child,
  which is what makes Stop possible — and what makes the suspend watchdog
  possible.
- **Reads transcripts.** The thread you see is built from
  `~/.aside/u/0/sessions/<id>/messages.jsonl`, tailed with a file watcher.
  Not from `aside.sessions.messages()`, which returns the agent's current
  *context* rather than the conversation and collapses a long session into
  one bare work fold.
- **Reads truthful state.** Per-session permission mode, pinned model,
  `runtimeConfig` and status come from `~/.aside/u/0/state.db`, opened
  **read-only**. Titles, unread state and the account default model come
  from the sanctioned `aside repl` facade (`aside.sessions.*`,
  `aside.settings.*`), cached behind a short TTL because each call spawns a
  ~139 MB binary.
- **Writes only through the daemon.** Permission changes go through
  `aside.sessions.update()`. Nothing writes to `state.db`, and nothing
  writes Aside's account-wide settings.

**The web app** (`miniapp/web/`, React 19 + Vite) mirrors the desktop
sidepanel: session list, thread with a collapsible work fold, subagent
cards, citations, files, the composer with its model / reasoning /
permission pickers, the task list, and settings.

**The socket** carries the thread itself, not a doorbell. The server
rebuilds the thread on every transcript write (a file read, no spawn) and
sends only the tail that changed, throttled to 150 ms. A second, provisional
stream carries the answer straight off the child's stdout so text appears
token by token, and is superseded the moment the transcript's own version
lands.

**Auth.** Telegram signs every Mini App launch with an HMAC over your bot
token. The server validates that signature, checks the user id against the
same one-person allowlist the chat bridge uses, and mints a 24-hour JWT that
every API call and the WebSocket must carry. The bot token never leaves the
process and is never logged.

At a glance:

```
Telegram app (phone)
  └─ Mini App webview ──HTTPS──▶ cloudflared tunnel
                                    └─▶ 127.0.0.1:8790  Node server
                                          ├─ spawns  aside exec        (turns)
                                          ├─ spawns  aside repl        (facade, cached)
                                          ├─ reads   state.db          (read-only)
                                          └─ tails   messages.jsonl    (transcripts)
```

The Python chat bridge (`bridge.py`) is a separate service on the same
machine, sharing the same `config.json` and the same Aside daemon. Neither
depends on the other.

---

## Setup

### Prerequisites

- macOS with [Aside](https://aside.so) installed and signed in.
- Node 20 or newer (`node --version`).
- The Telegram chat bridge already installed — the Mini App reads its
  `config.json` for the bot token and your user id. See the
  [README](../README.md#install-2-minutes).

### Install

From the repo root:

```bash
python3 miniapp/setup-miniapp.py
```

That checks Node and finds the bridge config, runs `npm install && npm run
build`, installs a launchd service (`com.aside.miniapp`), starts a
Cloudflare quick tunnel, registers the bot's menu button at the tunnel
URL, and prints the URL.

The menu button is the **Aside** entry next to the message box, and
registering it is what gives you something to tap. The wizard offers it
and defaults to yes; say no only if that bot's button already points
somewhere you want to keep. It is bot-wide, so one bot serves one Mini App
— see [Running a second instance](#running-a-second-instance). With it
off, set the button by hand in @BotFather → Bot Settings → Menu Button,
and expect to redo that on every restart, since only auto-registration
follows the tunnel URL when it rotates.

To do it by hand instead:

```bash
cd miniapp
npm install
npm run build
npm start          # serves on 127.0.0.1:8790
```

### Configure

Optional. Everything below lives in the `miniapp` section of the bridge's
`config.json`, which `setup.py` writes into your checkout (so
`~/aside-telegram-bridge/config.json` for a one-line install). The server
looks there first and falls back to
`~/.aside/u/0/telegram-bridge/config.json`; `MINIAPP_CONFIG` overrides
both, and the launchd service sets it explicitly.

| key | default | what it does |
|---|---|---|
| `port` | `8790` | loopback port to serve on |
| `tunnel` | `none` | `cloudflared` to publish an HTTPS URL |
| `auto_register_menu` | `false` | point the bot's menu button at the tunnel URL |
| `state_dir` | next to `config.json` | where the JWT secret, settings and cloudflared live |
| `cloudflared_path` | *(unset)* | use your own binary instead of downloading one |
| `log_path` / `log_max_bytes` | `miniapp.log`, 5 MB | server log and its rotation cap |

A top-level `models` section can add providers or models to the picker, and
`model_aliases` maps short names (`sonnet`) onto full ids.

Per-user preferences — the default model, reasoning effort and permission
mode for **new** sessions — are set in the app itself, under Settings, and
stored in `miniapp-settings.json` beside the config. They never touch
Aside's account-wide settings.

### Run

```bash
bridgemon miniapp start | stop | restart | logs
bridgemon status          # bridge and Mini App together
```

Open Telegram, tap the **Aside** button next to the message box.

### Running a second instance

Two servers started from the same config would fight over the bot's menu
button — `setChatMenuButton` is bot-wide, so the second one silently
repoints your live Mini App at its own throwaway tunnel. Use the env
kill-switches for anything that is not the real service:

```bash
MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0 MINIAPP_PORT=8799 npm start
```

### Development

```bash
cd miniapp
npm run dev            # server on 8790, Vite on 5273 with a proxy
npm run initdata       # a signed dev initData so the SPA can authenticate
npm test               # server + web suites
npm run typecheck
```

---

## Limitations

Read these before deciding something is broken.

- **A question the agent asks with its native tools can only be answered
  from your computer.** `ask_user_question` and
  `request_action_confirmation` suspend the session and wait for an answer
  over the daemon's own authenticated channel, and that channel is the
  desktop sidepanel — there is no CLI or repl path to it. The Mini App
  renders such a question faithfully, read-only, with a notice saying
  where to answer it, and refuses to send into a suspended session rather
  than queueing a turn that would hang forever.

  Sessions started from your phone — by the Mini App **or** by texting the
  bot — are told not to use those tools, and to emit a `[[QUESTION]]` block
  and end the turn instead. Those render as the same card with working
  buttons, because answering one is just an ordinary follow-up message. The
  instruction rides on the first message and a one-line reminder rides on
  every follow-up, so context compaction cannot quietly drop it.

  When one turns up anyway, the card offers **Continue in a new session**:
  the options become tappable again and seed a fresh session that starts
  knowing what was asked, what you picked, and what the stuck session was
  originally for. The stuck session stays as it is; nothing can unstick it.

  **Residual risk.** A new session's `runtimeConfig` — including the
  final-confirm flag — only binds on the *next* `aside exec` spawn, and
  `aside exec` has no flag or environment variable that would bind it at
  create time. So the very first turn of a brand new session still runs
  under whatever your account default was, and the preamble is the only
  cover for that one turn. [docs/NATIVE-QUESTIONS.md](NATIVE-QUESTIONS.md)
  has the whole picture.
- **The "Confirm before acting" switch is not Aside's `finalConfirm`.**
  On a session driven from a phone it cannot be: the daemon's flag mandates
  `request_action_confirmation`, which is precisely the tool that suspends
  the session on a prompt your phone cannot answer. On these sessions the
  switch adds a stronger line to the agent's instructions instead —
  confirm with a `[[QUESTION]]` card before anything external or
  irreversible — and the daemon flag is explicitly held off. On a session
  you started on the desktop, where the sidepanel is there to answer, the
  switch still writes the daemon's own flag.
- **You can stop a turn, but you cannot steer one.** Stop kills the
  `aside exec` child the server owns (SIGTERM, then SIGKILL) and the
  transcript keeps whatever the agent got through. Mid-turn steering is not
  possible: the CLI drops prompts sent to a busy session, so a message sent
  mid-task queues and runs as the next turn.
- **Sessions you start from the Mini App (or the chat bridge) don't appear
  in the desktop Aside app.** They are created through the CLI, and the
  daemon marks CLI-created sessions ephemeral, which is what the desktop
  chat list filters out. The other direction works completely: anything you
  start on the desktop is visible, continuable and watchable live from your
  phone.
- **Your Mac has to be awake and online.** The server and the tunnel run on
  it. Asleep is offline.
- **The tunnel URL changes on every restart.** Quick tunnels are ephemeral.
  The server re-registers the menu button at the new hostname each time it
  rotates, so it self-heals — but a saved link goes stale. For a fixed URL,
  set up a named Cloudflare tunnel with your own domain.
- **One bot, one Mini App.** The menu button is bot-wide, so a second
  machine using the same token takes the button from the first. Make a
  second bot with @BotFather if you want two.
- **"Max" reasoning is not sendable.** Aside's own UI offers it; `aside exec
  --effort max` rejects it. The picker hides it rather than silently running
  something else under that name.
- **No live browser view.** You can watch the agent's tool calls, not its
  tab.
- **Settings here are the Mini App's own.** Changing a default for new
  sessions does not change what Aside uses on your computer. Your account's
  own defaults are shown on the settings screen, read-only.

---

## Layout

```
miniapp/
  server/src/
    app.ts          Fastify routes: auth, reads, writes, SPA host
    exec.ts         aside exec children, the queue, stop, suspend watchdog
    ws.ts           the live thread socket
    thread.ts       transcript -> the items the UI draws
    threadstore.ts  snapshots, tail diffs, the subagent join
    facade.ts       aside repl, with a TTL + in-flight cache
    statedb.ts      state.db, read-only
    questions.ts    ask_user_question / [[QUESTION]] cards
    errors.ts       provider failures -> Aside's alert card
    todos.ts        write_todos replay
    settings.ts     defaults for new sessions
    preamble.ts     the mobile-session instruction block + reminder
    softconfirm.ts  per-session soft "confirm before acting"
  web/src/
    App.tsx         the shell: home, thread, settings
    components/     the sidepanel, recreated
    theme/          Aside's design tokens
```
