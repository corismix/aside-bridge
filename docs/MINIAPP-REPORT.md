# Aside Mobile — Telegram Mini App (Phases 0–2)

A React SPA that runs inside Telegram's webview and gives the owner full
remote access to their Aside agent sessions: browse sessions, read
transcripts, send messages, watch replies stream live. Served by a small
Node/TypeScript API that authenticates via Telegram's signed `initData`.

**This is purely additive.** Nothing outside `miniapp/` and this file was
touched. The Python chat bridge (`bridge.py`) is untouched and keeps running
in production from `~/.aside/u/0/telegram-bridge/`. No Telegram Bot API
endpoint is called anywhere in this codebase — the bot token is used only as
HMAC key material for `initData` validation, so the live bridge remains the
sole `getUpdates` consumer.

---

## 1. What was built

### `miniapp/server/` — Fastify + ws, single process, no database

| File | Role |
|---|---|
| `config.ts` | Reads the bridge `config.json`; loads/generates the JWT secret |
| `initdata.ts` | Telegram `initData` validation + owner allowlist |
| `auth.ts` | HS256 JWT mint/verify |
| `transcript.ts` | `messages.jsonl` parser (ported from `bridge.py`) |
| `sessions.ts` | Session discovery, titles, previews, usage totals |
| `exec.ts` | `aside exec` child processes + per-session turn queue |
| `watcher.ts` | Live tail of a session transcript |
| `ws.ts` | WebSocket subscribe/backfill/live-entry transport |
| `app.ts` | Route wiring, rate limits, SPA hosting |
| `index.ts` | Entry point |

**Endpoints**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth` | — | Validate `initDataRaw`, mint a 24h JWT |
| `GET` | `/api/health` | — | Liveness |
| `GET` | `/api/sessions?limit=` | Bearer | Sessions, newest first |
| `GET` | `/api/sessions/:id/messages?afterLine=&limit=` | Bearer | Parsed transcript entries |
| `POST` | `/api/sessions/:id/send` | Bearer | Queue a turn, returns immediately |
| `POST` | `/api/sessions/new` | Bearer | Start a session, return its id |
| `GET` | `/api/status` | Bearer | In-flight turns, uptime, models, effort levels |
| `WS` | `/ws` | Bearer | Live transcript + turn lifecycle |

### `miniapp/web/` — React 19 + Vite + TypeScript

Three surfaces: **session list** (search, relative time, preview, turn/token/cost
tags, live "working" markers, refresh, floating **+ New chat**), **transcript**
(right-aligned tinted user bubbles, assistant markdown, collapsible work folds,
live updates, bottom-pinned auto-scroll with a "Latest" escape hatch), and the
**composer** (auto-growing multiline input, send button, model + effort pill
chips opening frosted bottom sheets, spinner + queued count while busy).

### `miniapp/scripts/`

- `sign-initdata.mjs` — hand-rolled spec-exact `initData` signer.
- `dev-initdata.mjs` — prints a browser URL carrying a valid signed payload.

---

## 2. How to run

All commands from `miniapp/` with `/opt/homebrew/bin` on `PATH` (Node v23.11.0).

```bash
cd miniapp
npm install                # workspaces: server + web
npm run build              # web (vite) then server (tsc)
npm test                   # vitest, server package
npm run typecheck          # tsc --noEmit across both packages

npm start                  # production: serves the built SPA + API on :8790
npm run dev                # dev: tsc watch + node watch + vite on :5273
```

`npm run dev` starts the API on `MINIAPP_PORT` (default **8790**) and Vite on
**5273** with `/api` and `/ws` proxied to the API, so the SPA hot-reloads while
talking to the real server.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `MINIAPP_PORT` | `8790` | API port |
| `MINIAPP_HOST` | `127.0.0.1` | Bind address |
| `MINIAPP_CONFIG` | `~/.aside/u/0/telegram-bridge/config.json` | Bridge config |
| `MINIAPP_SESSIONS_DIR` | from config / `~/.aside/u/0/sessions` | Sessions root |
| `MINIAPP_ASIDE_CLI` | from config | Path to the `aside` binary |
| `MINIAPP_SECRET_PATH` | next to the config | JWT secret file |
| `MINIAPP_WEB_DIST` | `../web/dist` | Built SPA to serve |
| `MINIAPP_GRANT_FULL_ACCESS` | unset | `1` grants new sessions full-access (see §6) |
| `MINIAPP_LOG` | on | `0` silences the request logger |

### The dev-initData harness

Exercises the **real** auth path from an ordinary desktop browser — no Telegram
required, no validation bypass:

```bash
node miniapp/scripts/dev-initdata.mjs                    # desktop field set
node miniapp/scripts/dev-initdata.mjs --platform ios     # iOS field set
node miniapp/scripts/dev-initdata.mjs --port 8790 --host 127.0.0.1
```

It prints one line:

```
http://127.0.0.1:8790/#initData=<urlencoded signed payload>
```

Open it in a browser. The SPA reads the `#initData=` hash, POSTs it to
`/api/auth`, and the server validates the HMAC exactly as it would for a real
Telegram launch. The payload is signed with the real bot token but **contains
no token** — only the signature it produces — and expires after 15 minutes.
The app stashes it in `sessionStorage` and strips it from the URL bar so
reloads keep working.

---

## 3. Architecture notes

### The auth spine

`secret_key = HMAC_SHA256(bot_token, "WebAppData")`, data-check-string is every
present field except `hash` and `signature`, sorted alphabetically as `k=v` and
joined with `\n`, compared timing-safely against `hash`. Signature verification
is delegated to `@telegram-apps/init-data-node` (installed cleanly, 0 audit
findings); the `user` field is parsed by our own code so an unexpected extra
field from a future Telegram client can never turn a cryptographically valid
launch into a 401.

**Platform variance is handled by construction**: nothing enumerates an
expected field set. iOS menu-button launches (no `query_id`, plus
`chat_instance`/`chat_type`) and desktop launches (with `query_id`) are both
covered by tests, as is an invented `some_future_field`.

Rejections: stale `auth_date` (>15 min) → 401 `expired`; bad HMAC → 401
`bad_signature`; valid signature but a different Telegram user → **403**
`forbidden_user`. Success mints an HS256 JWT (24h, subject = user id) signed
with 32 random bytes generated on first run and persisted to
`~/.aside/u/0/telegram-bridge/miniapp-secret.json`, `chmod 600`, outside the
repo. Every other route re-checks the allowlist on each request, so revoking
`chat_id` in the config takes effect immediately rather than at token expiry.

Rate limits: `/api/auth` 10/min/IP, everything else 120/min.

### What was ported from `bridge.py` (not rewritten)

- **Transcript reading is byte-offset based and stops at the last newline.**
  A live `messages.jsonl` routinely ends mid-write; the partial line is picked
  up on the next pass. This is `stream_new`'s guarantee, and the integration
  test asserts it explicitly by appending a half-line and checking nothing is
  emitted until it is terminated.
- **Tool labels** are `arguments.title` with a fallback to the raw tool name.
- **Subagent lifecycle.** Subagents spawn under a `toolCallId` but every later
  event references only a `task_id`, which first appears in the spawn
  `toolResult`'s `details.taskId`. The parser re-keys its registry on that
  event — without it, every `subagent_wait` result would render as an unknown
  agent id. Verified against a real transcript: the `wait` and `result` events
  both resolved back to the spawn's description.
- **`subagent_wait` results** arrive as one blob of
  `<subagent_result task_id="...">` blocks; each becomes its own entry.
- **Serial turns per session with batching.** The CLI silently drops prompts
  sent to a busy session, so a second concurrent turn is lost, not parallel.
  Queued messages that share model and effort batch into one turn joined by a
  blank line — the behaviour that makes rapid-fire typing sane.
- **Session id resolution**: directories are `<date>_<sessionId>`; the CLI
  takes the trailing short id, resolved by scanning for a directory ending in
  `_<id>`.
- **Title derivation** skips the identical persona seed the bridge writes into
  every `/new` session and trims the trailing `[bridge note …]` tag.

### Stable cursors

Every entry carries `line` (physical JSONL line) and `part` (index within that
line) plus a derived `id`. `afterLine` is the cursor for both REST and the
socket. Lines before the cursor are still replayed through the parser (so
subagent descriptions resolve) and then filtered out.

### The subscribe race

On subscribe the watcher is acquired **before** the backlog is read, and
anything it emits meanwhile is buffered and replayed with a line filter. Doing
it the other way round silently drops every line written between the two
reads. Duplicate ids are also dropped client-side.

`fs.watch` is the fast path; a 1.5s poll is the fallback (`fs.watch` is
unreliable across atomic renames, and the file does not exist yet for a session
the CLI is still creating). Watchers are refcounted and shared across
subscribers.

### `POST /api/sessions/new`

Snapshots the session directories, spawns `aside exec` with no `--session`,
then polls for a directory that was not there before. The id is returned as
soon as it appears (~0.6s in the live test) while the turn keeps running, so
the client can subscribe and watch the first reply stream in rather than
waiting for the whole turn.

### Design system

`miniapp/web/src/theme/` — `tokens.css` (all custom properties, light + dark),
`base.css` (reset, primitives), `components.css` (screens).

Geist Variable and Geist Mono are bundled locally via `@fontsource-variable`
(12 woff2 subsets in `dist/assets/`) — no runtime font CDN. Light theme: page
`#FAFAFA`, cards pure white, ink `#0B0D10`, hairline borders
`rgba(0,0,0,0.10)` at 0.5px. Accent Aside blue `#3E8FE8` with `#EAF4FF` /
`#DCEEFF` washes for user bubbles and selected rows. Dark theme derives from
Telegram `colorScheme`: bg `#0E0F12`, cards `#16181D`, glass
`rgba(22,24,29,0.72)`, same accent.

Frosted glass is applied to the chrome layer only — app bar, composer, bottom
sheets, the floating "Latest" pill and toasts — as
`backdrop-filter: blur(20px) saturate(1.5)` plus a 1px inset white highlight
and a hairline outer border, wrapped in `@supports` with a solid fallback
colour for webviews without `backdrop-filter`. Content surfaces (cards,
bubbles, markdown) stay fully opaque. Radii: 12px cards/bubbles, 16–22px
panels/sheets, fully rounded pills. Shadows are the layered soft pair plus a
hairline ring. Motion is 150ms with a press-scale of 0.97, disabled under
`prefers-reduced-motion`.

Telegram's `themeParams` are read for the page backdrop only, deliberately:
inheriting a heavily themed client's full palette would stop the app looking
like Aside.

### The work fold

Contiguous runs of thinking / tool calls / subagent events collapse into one
tappable row — `Worked for 3m 38s · 2 steps · <latest step>` — mirroring
Aside's native fold. Expanding shows a timestamped step list with `+m:ss`
offsets, per-kind icons, italic thinking, profile badges on subagents, and
result snippets. Successful tool *results* are dropped from the list (the call
already named the step); failures are kept, since a failing step is the reason
you open the fold. While a turn runs, the trailing fold switches to a live
"Working · <latest step>" row with a pulsing dot.

---

## 4. Test results

`npm test` — **58 tests across 6 files, all passing.**

```
 RUN  v3.2.7 ~/…/miniapp/server

 ✓ test/initdata.test.ts (11 tests) 11ms
 ✓ test/transcript.test.ts (8 tests) 11ms
 ✓ test/sessions.test.ts (11 tests) 48ms
 ✓ test/api.test.ts (11 tests) 118ms
 ✓ test/exec.test.ts (11 tests) 317ms
 ✓ test/integration.test.ts (6 tests) 2425ms
   ✓ integration smoke > streams newly appended transcript lines over the WebSocket  2161ms

 Test Files  6 passed (6)
      Tests  58 passed (58)
   Duration  2.87s
```

Coverage against the acceptance criteria:

- **initData** (11): valid desktop passes; valid iOS field set passes; unknown
  future field passes; tampered `hash` fails; tampered payload under an intact
  hash fails; signature from a different bot token fails; `auth_date` 16 min
  old fails; 14 min old passes; different user id → `forbidden_user`; missing
  hash and empty input fail; signed payload with no `user` fails. The signer
  used by the tests is our own hand-rolled implementation, independent of the
  library that validates — so these prove interoperability, not that a library
  agrees with itself.
- **JWT middleware** (5, in `api.test.ts`): missing → 401 `missing`; garbage →
  401 `invalid`; expired → 401 `expired`; wrong signing secret → 401; validly
  signed token for a non-allowlisted user → 401 `forbidden`. Plus `/api/auth`
  rate limiting: 10× 401 then 429.
- **Transcript parser** (8): text, thinking, titled and untitled tool calls,
  error tool results, stable ids, full subagent lifecycle across the task_id
  re-key, multi-`task_id` wait results, partial trailing line dropped then
  emitted once completed, `afterLine` filtering that still replays state,
  corrupt lines skipped.
- **Session lister** (11): ordering, titles, previews, turn counts, token and
  cost totals, persona-seed skipping, `limit`, dirs without transcripts,
  missing root, cache invalidation on append, id validation and traversal
  refusal.
- **Turn queue** (11): serialisation, batching rules, per-session independence,
  argv-array safety, lifecycle events, stderr surfacing, `status()`, new-session
  discovery and its failure path.
- **Integration** (6): real socket — sign → `/api/auth` → `/api/sessions` →
  transcript fetch → WS auth rejection → subscribe → append lines → assert
  parsed entries arrive → assert a half-written line is withheld → assert it
  arrives once completed → backfill on rejoin → bad/unknown session refusals.

`npm run typecheck` — clean across both packages (server sources **and**
tests, plus the web app).

`npm run build` — green:

```
✓ 297 modules transformed.
dist/index.html                     0.85 kB │ gzip:   0.49 kB
dist/assets/index-DvL_Egse.css     19.70 kB │ gzip:   4.60 kB
dist/assets/index-Dz29KWJV.js     374.89 kB │ gzip: 116.16 kB
  (+ 12 locally bundled Geist / Geist Mono woff2 subsets)
✓ built in 650ms

> @aside-miniapp/server@0.1.0 build
> tsc -p tsconfig.json
```

`npm audit` — **0 vulnerabilities** (`@fastify/static` was pinned to ≥10.1.2
to clear four path-traversal advisories present in the 8.x line).

### Against the real machine (read-only)

Server started on the real config and sessions dir:

- `dev-initdata.mjs --platform ios` → `/api/auth` **200**, token minted.
  Flipping one character of that payload → **401 `bad_signature`**.
- `/api/sessions?limit=5` → 5 real sessions with correct turn counts, context
  tokens and cost totals.
- Transcript of a real 48-line session → 81 entries,
  `{user: 3, thinking: 19, tool_call: 23, tool_result: 23, assistant_text: 13}`,
  16 distinct tool titles with the name-fallback path exercised.
- A real subagent-bearing session → spawn/wait/result all parsed, and the
  `result` event's description resolved back to the spawn's 25-character
  description via the task_id re-key (1 of 1).

### Live-fire test (2 CLI invocations, the stated maximum)

Throwaway session id: **`0qxM3TX8G2zcw44U`** (created by this test; no existing
session was touched).

```
[+0.6s] POST /api/sessions/new -> 200 {"sessionId":"0qxM3TX8G2zcw44U","accepted":true}
[+0.6s] ws open, subscribing
[+0.6s] frame {"type":"ready"}
[+0.6s] frame {"type":"subscribed","sessionId":"0qxM3TX8G2zcw44U","lastLine":0,"busy":true,"queued":0}
[+0.6s] entry line=0 kind=user "Reply with exactly the word: pong"
[+2.5s] entry line=1 kind=assistant_text "pong"
[+2.5s] frame {"type":"turn_finished","sessionId":"0qxM3TX8G2zcw44U","exitCode":0,"durationMs":2521}
```

Second invocation, exercising `POST /api/sessions/:id/send` into the same
throwaway session:

```
[+0.0s] frame {"type":"subscribed","sessionId":"0qxM3TX8G2zcw44U","lastLine":1,"busy":false,"queued":0}
[+0.0s] frame {"type":"turn_started","sessionId":"0qxM3TX8G2zcw44U","model":"claude-sonnet-5","effort":"low"}
[+0.0s] POST /send -> 200 {"accepted":true,"queued":0,"busy":true}
[+0.4s] entry line=2 kind=user "Reply with exactly the word: pong2"
[+2.1s] entry line=3 kind=assistant_text "pong2"
[+2.1s] frame {"type":"turn_finished","sessionId":"0qxM3TX8G2zcw44U","exitCode":0,"durationMs":2125}
```

Model `claude-sonnet-5`, effort `low`, both turns exit 0.

### UI verification

The built SPA was opened in a desktop browser at 430×900 through the
dev-initData URL and driven manually: session list rendered with real data;
opening the throwaway session showed both user bubbles and both `pong` replies;
a large real session rendered markdown (headings, bold, inline code, lists,
tables) with fold rows reading `Worked for 3m 38s · 2 steps · …`; expanding one
showed the timestamped step list (`+0:00`, `+0:25`, `+0:35`) with gear and
sparkle icons and italic thinking; the "Latest" pill appeared on scroll-up;
the effort sheet rose as a frosted panel with `high` selected. Dark theme was
forced and re-checked. Computed styles confirmed
`backdrop-filter: blur(20px) saturate(1.5)` live on both the app bar and the
composer, and `Geist Variable` as the resolved body font.

---

## 5. Security notes

- The bot token is read from the bridge config and used **only** as HMAC key
  material. It is never logged, never echoed, never written to the repo, and
  never sent anywhere. The startup log deliberately prints only the sessions
  dir and the SPA path.
- **No Telegram Bot API call exists in this codebase.** The live bridge remains
  the sole `getUpdates` consumer.
- The JWT secret lives at `~/.aside/u/0/telegram-bridge/miniapp-secret.json`,
  `chmod 600`, outside the repo (verified `-rw-------`).
- Session ids are validated against `^[A-Za-z0-9_-]{1,128}$` **and** resolved by
  scanning for a matching directory, so no caller-supplied string can escape
  the sessions root. `../../etc` is rejected on both REST and the socket.
- Prompts are passed to the CLI as an argv array, never a shell string, so text
  containing quotes or `$(...)` cannot inject.
- Markdown is rendered by `react-markdown` **without** `rehype-raw` — transcript
  text (tool output, quoted web pages) never gets to emit HTML.
- The server binds `127.0.0.1` by default. Exposing it to Telegram requires a
  tunnel in front, which is out of scope for these phases.

---

## 6. Deviations from the spec, and why

1. **`@telegram-apps/init-data-node` v2's exported `validate` takes a
   `signData` function as its third argument**, not an options object; the
   package's Node entry point exposes the `(value, token, options)` shape the
   spec assumed. We use the Node entry and classify failures via the library's
   typed error predicates (`isExpiredError`, `isSignatureMissingError`) rather
   than string matching.

2. **`user` is parsed by our own code**, not the library's schema, so a future
   Telegram field cannot turn a valid launch into a 401. Signature and expiry
   checking are still the library's.

3. **New sessions are not granted full-access by default.** `bridge.py`'s
   `/new` path runs a second `aside repl` call to set
   `permissionMode: 'full-access'`. Silently widening permissions from a new
   surface felt like the owner's call, not mine, so it is implemented behind
   `MINIAPP_GRANT_FULL_ACCESS=1` and off by default. Sessions created from the
   mini app therefore start in guard mode. Flip the env var to match the
   bridge's behaviour.

4. **No persona seeding**, as specified — `POST /api/sessions/new` starts a
   plain session with the user's own first message. A consequence worth
   knowing: sessions created here will not carry the texting-style persona the
   Telegram chat bridge relies on, which is correct for a full-UI client.

5. **`telegram-web-app.js` is loaded from `telegram.org`** in `index.html`.
   This is Telegram's own bridge script and the supported way to obtain
   `initData` inside the webview; it is absent (and harmless) in a plain
   browser. The no-CDN rule was applied to fonts, which are fully bundled.
   `@telegram-apps/sdk` was not used — the raw bridge is a smaller surface for
   the four things needed here (expand, BackButton, colorScheme, haptics), and
   the spec allowed either.

6. **Successful tool results are omitted from the expanded work fold** (see
   §3). Failures are always shown. This keeps the step count honest — it
   matches the number of rows actually rendered.

7. **Two live CLI invocations were used**, the stated maximum: one for
   `POST /api/sessions/new` and one for `POST /api/sessions/:id/send`, both
   against the same throwaway session `0qxM3TX8G2zcw44U`. The second was spent
   to prove the Phase 2 write path end-to-end rather than leaving it covered
   only by fakes.

8. **`GET /api/sessions/:id/messages` caps entries** at `limit` (default 800,
   max 5000) and returns `truncated`. Real sessions reach 400+ entries and
   1.5 MB transcripts; an uncapped response would be a large payload over a
   phone connection. The cap keeps the newest entries.

---

## 7. Not done (out of scope for Phases 0–2)

- No tunnel/HTTPS setup, no BotFather Mini App registration, no menu-button
  wiring — all of which require Bot API calls or account changes.
- No image/attachment rendering; transcripts referencing local artifact images
  show a broken-image placeholder.
- No mid-turn steering. The CLI drops prompts sent to a busy session, so the
  bridge's queueing semantics are reproduced rather than papered over.
- Nothing is committed or pushed.

---
---

# Revision 2 — pixel-mirror the real Aside sidepanel

The Phase 0–2 build was rejected on its UI: *"It looks nothing like Aside UI
at all… IT SHOULD BE THE SAME FUNCTIONALITY AS EVERYTHING IN THE ASIDE
BROWSER."* That verdict was right. The first pass designed *from* Aside's
marketing site; this pass mirrors the actual sidepanel, using the owner's
screenshots and Aside's own stylesheet as the contract.

The auth spine, WS transport and turn-queue logic were kept. The visual
layer and the data sources were rebuilt.

## R1 — the UI

**Design tokens.** The invented palette (`#3E8FE8`, `#EAF4FF` icy-blue
washes) is gone. `web/src/theme/tokens.css` is now transcribed from Aside's
own `globals-*.css`: the oklch system (`--accent: oklch(14.5% 0 0/.1)`,
`--border`, `--border-surface-strong`, `--muted-foreground`,
`--surface-primary/secondary/tertiary`, the 98.5%-lightness dark
counterparts), `--hairline: .5px`, the blur scale, and the squircle radius
scale (`calc(Xrem * var(--squircle-factor))`, factor 1.4). Aside's system is
near-neutral — black or white at low alpha over the background — with sky
used sparingly as `--brand` and orange reserved for the permission label.
Font stacks name `Aside Display` / `Berkeley Mono` first and fall through to
the Geist faces we actually bundle. **Neither the CSS file nor Aside's
proprietary fonts were copied into the repo.**

**Home screen** is the sidepanel home: composer card at the top ("Ask AI a
task, @ for context", `+`, `✳ Fable 5 ∨`, `High ∨`, round dark send
button) — sending from it creates a new session, so the old "+ New chat" FAB
is gone. Below it a `List | Card` segmented control (choice persisted in
`localStorage`; List is the mobile default), plus search and sort. List rows
show title, relative time, an unread dot (`readAt < updatedAt`) and a
spinner when `status === "running"`. Card view shows relative time, bold
title and a clamped preview. **No ids, costs, token counts or turn counts
anywhere.**

**Thread screen**: user turns are light-grey rounded bubbles (not
blue-tinted); one `Worked for 39m 8s ›` fold per contiguous work block,
collapsed by default, with the final answer as plain markdown on the page
background. Expanding reveals the vertical hairline timeline — monochrome
icon + plain-text label per step, `Wrote miniapp-spec.md +75 -0` diffstats
in green/red, inline screenshot thumbnails, mid-turn commentary as ordinary
paragraphs — and each tool step expands into a detail card (title + grey
`Success`/`Error` badge + monospace command and output, with "Show more").
**All per-step time offsets removed.** While a turn runs the trailing fold
shows the live step label with a spinner instead of a duration.

**Bottom bar**: permission label on the left (orange when `Full access`),
model + effort pills on the right with a spinner between them while busy.
Reply composer ("Reply, @ for context") sits directly above it.

**Icons** are lucide-react in monochrome `currentColor` (terminal, globe,
file, search, …). The previous mixed icon set is gone. Frosted glass is now
restrained to the surfaces Aside actually blurs — popovers and the thread
footer, at `--blur-xl`, with opaque `@supports not` fallbacks.

Removed: `Transcript.tsx`, `Sheet.tsx`, `utils/grouping.ts`,
`hooks/useTranscript.ts`. Added: `Thread.tsx`, `Popover.tsx`, `Pickers.tsx`,
`hooks/useThread.ts`.

## R2 — effort levels

Labels now match Aside exactly: `off:"Off", minimal:"Minimal", low:"Low",
medium:"Medium", high:"High", xhigh:"Extra High", max:"Max",
ultrabrowse:"Ultrabrowse"`. The Reasoning popover reproduces the real one —
title "Reasoning", checkmark on the current level, Ultrabrowse in rainbow
gradient text using Aside's own `--ultrabrowse-*` stops. Off and Minimal are
still accepted by the API but are not in the menu, matching Aside.

**Max-effort verification (as instructed).** Ran against the real binary:

```
$ aside exec --effort max "noop"
error: option '--effort <effort>' argument 'max' is invalid.
        Allowed choices are off, minimal, low, medium, high, xhigh, ultrabrowse.
```

`max` is genuinely unsendable through the CLI. **"Max" is therefore hidden
from the picker and is NOT silently remapped onto xhigh** — remapping would
misreport what the turn actually ran at. `EFFORT_MENU` is
`[low, medium, high, xhigh, ultrabrowse]`, asserted in tests.

## R3 — provider / model catalog

There is no catalog-listing command, so `server/src/catalog.ts` holds a
curated table keyed by credential provider id, **seeded from the top-level
KEYS of `credentials.json` only** — values are never read, held or logged.
Display names and model ids follow Aside's picker: `claude-code` → "Claude"
(Fable 5, Opus 5, Opus 4.8, Sonnet 5, Haiku 4.5), `openai-codex` → "ChatGPT"
(GPT-5.6 Terra/Luna, GPT-5.5, GPT-5.4, GPT-5.4 mini, GPT-5.3 Codex Spark),
`xai-grok-oauth` → "Grok" (Grok 4.5, Grok 4 Fast). Credentialed providers
sort first; an unknown credentialed provider still gets a row.

Model ids drift, so an optional `models` section in the bridge config is
merged over the built-ins — it can add models, rename a provider, `replace`
a list outright, or add a provider with no built-in entry.

The pills open showing the daemon's *actual* current default, read via
`aside.settings.getAll().defaultModel` (currently `claude-code` /
`claude-fable-5` / `high`) and exposed on `/api/status`. The picker matches
the real popover: "Search models" field filtering across every provider,
provider rows with chevrons into a model submenu, checkmark on current,
"Settings ↗" at the bottom.

`exec.ts` now captures **stdout** as well as stderr: the daemon prints
`Requested model <p>/<m> is not available for this account…` there, often
while still exiting 0, so it was previously being discarded. It is matched
by `modelUnavailableIn()` and surfaced verbatim as a red-tinted system row
in the thread.

## R4 / R5 — data fidelity through the CLI facade

`server/src/facade.ts` wraps `aside repl "<js>"`. Two transport details are
handled once: the CLI appends an ANSI `[ok | 12ms]` trailer so raw stdout is
never valid JSON (payloads are wrapped in sentinels rather than guessed at),
and every call spawns a ~139 MB binary, so reads go through a short-TTL
cache that also coalesces concurrent calls for the same key.

- **Session list** — `aside.sessions.list({ limit: 100 })`. Probed the
  signature: the bare call returns 20, but **`{limit: 100}` returns all 93
  sessions**, so no filesystem merge is needed. Real `title`, `status`,
  `readAt`/`updatedAt`/`createdAt`, `trigger`; unread is `readAt <
  updatedAt`. First-message-derived titles are gone. If the facade is
  unreachable the old filesystem path still answers, so the app degrades
  rather than blanking.
- **Transcript** — `aside.sessions.messages(id)` for the initial load, via
  the new `GET /api/sessions/:id/thread`. The jsonl tail is kept **only** as
  the live-delta signal: the WS says "something changed", and the structured
  thread is refetched (throttled), so live updates render through the same
  model as the first load.
- **Mark read** — `aside.sessions.markRead(id)` fires when a thread opens,
  best-effort, so unread state stays in sync with the browser.
- **Preview text** is the last assistant paragraph, read from the local
  transcript rather than one facade spawn per session, and now run through
  `stripMarkdown()` so cards show prose instead of `**Opener**`.

`server/src/thread.ts` turns the transcript into what the sidepanel draws.
The rules, all discovered from real data: a turn runs user-message to
user-message; the **last** assistant text part is the answer and everything
before it collapses into the fold; `thinking` parts are never surfaced; a
step's label is `arguments.title` when the tool supplies one (bash and repl
do) and is otherwise derived per tool; diffstats come from
`details.diff` for `edit_file` and from the written content for
`write_file`; tool detail cards carry `arguments` + `toolResult` content,
truncated at 4 000 chars with an expandable "show more".

## R6 — productionized setup

`server/src/tunnel.ts` manages a cloudflared quick tunnel: platform
detection (`darwin-arm64/amd64` tarballs, `linux-amd64/arm64/arm` raw
binaries), one-time download from the official Cloudflare release URL to
`~/.aside/u/0/telegram-bridge/bin/cloudflared` (**never the repo**), chmod,
spawn, URL parse from either stream, supervised restart with capped
exponential backoff, and re-notification on hostname rotation. `rotateLog()`
caps the log file.

`miniapp/setup-miniapp.py` (python3 stdlib only, matching `setup.py`'s
style) is an idempotent wizard: verify Node ≥ 20 with a friendly install
hint, `npm install && npm run build`, write `miniapp.*` keys into the
existing bridge `config.json`, generate and bootstrap
`com.aside.miniapp.plist`, health-check `/api/health`, then print the tunnel
URL and what to expect in Telegram. **`setup.py` and `install.sh` were not
touched** — integration into the main installer is a release-time step.

**End-user story:** `curl … install.sh` → wizard runs → the bot's menu button
appears in Telegram → tap it → the Mini App opens. The one prerequisite is
Node 20+; cloudflared installs itself.

**The trycloudflare tradeoff:** a quick tunnel needs no Cloudflare account,
but its hostname is ephemeral and changes on every restart. That is exactly
why the menu button is re-registered on rotation. For a URL that never
moves, a named tunnel with a custom domain can be pointed at the same port
later — that path is additive and needs no code change here.

**`setChatMenuButton` is the only Bot API method implemented. It is OFF by
default (`miniapp.auto_register_menu`), and it was never called during this
build — verified by construction: the only test that exercises it injects
its own `fetch`.**

## Testing

`npm test` — **114 passed / 114** (was 58). New suites:

- `catalog.test.ts` (11) — credential seeding reads keys only; malformed and
  missing files degrade safely; Aside display names and model ids; config
  merge/replace/rename; unknown providers.
- `facade.test.ts` (27) — sentinel parsing around the real ANSI trailer;
  cache TTL, in-flight coalescing, key separation, mutation bypass;
  effort labels and the Max exclusion; step labels and icon mapping;
  diffstat counting; `buildThread` grouping, thinking suppression,
  **assertion that no per-step timestamps are emitted**, running state,
  error status, inline images; `modelUnavailableIn`.
- `tunnel.test.ts` (14) — URL parsing from a captured cloudflared banner and
  from a bare chunk; platform asset matrix; supervised spawn with a fake
  child; rotation fires once per change; URL cleared on exit; **menu payload
  construction and `setChatMenuButton` through an injected fetch**; log
  rotation.
- `transcript.test.ts` +4 — `stripMarkdown`.

One pre-existing test was invalidated by the data-source switch and updated:
`/api/status` no longer returns a `models` alias list, so it now asserts the
`catalog` shape and the effort menu.

```
 ✓ test/catalog.test.ts (11 tests)      ✓ test/tunnel.test.ts (14 tests)
 ✓ test/transcript.test.ts (12 tests)   ✓ test/facade.test.ts (27 tests)
 ✓ test/initdata.test.ts (11 tests)     ✓ test/sessions.test.ts (11 tests)
 ✓ test/api.test.ts (11 tests)          ✓ test/exec.test.ts (11 tests)
 ✓ test/integration.test.ts (6 tests)
 Test Files  9 passed (9)
      Tests  114 passed (114)
```

`npm run build` and both typechecks are green.

## Live verification

Server restarted on port 8790 against the real config, **tunnel disabled,
`auto_register_menu` false**, driven through the dev-initdata harness (real
signed initData — no auth bypass), Chrome at 430×932.

- `/api/sessions` → `source: facade`, **93 sessions**, 30 unread, 1 running.
  Real titles (the owner's own working sessions, not shown here), no
  ids/costs/tokens in the payload.
- `/api/status` → catalog with Claude/ChatGPT/Grok all `connected: true`,
  defaults `claude-code / claude-fable-5 / high` → pills read `✳ Fable 5 ∨`
  and `High ∨`; effort menu `[Low, Medium, High, Extra High, Ultrabrowse]`.
- This task's own build session (`<build-session>`) renders one running
  fold over 27 steps and 5 mid-turn paragraphs, reproducing the reference
  screenshot line for line: `>_ Checking Orca repo registration options`,
  `⊕ Extracting aside.com design tokens`, `⊕ Inspecting nav frosted glass
  and page sections` with its inline screenshot, `>_ Cloning bridge repo and
  checking tooling`, and **`▤ Wrote miniapp-spec.md +75 -0`** with the
  green/red diffstat. Expanding `Checking Orca repo registration options`
  gives the detail card with a grey `Success` badge and the monospace
  command/output. A finished session (`<finished-session>`) shows
  `Worked for 7m 43s` plus its markdown answer.
- Reasoning and model popovers verified visually against the reference
  screenshots, including rainbow Ultrabrowse and the ChatGPT submenu
  (GPT-5.6 Terra → GPT-5.3 Codex Spark). Light and dark both checked.

**Tunnel** — the single permitted manual spawn: the darwin-arm64 tarball
downloaded and extracted, and the URL parsed live:

```
asset for this machine: {"asset":"cloudflared-darwin-arm64.tgz","archive":"tgz"}
  [ensure] downloading cloudflared (cloudflared-darwin-arm64.tgz)
  [ensure] cloudflared ready
binary at: ~/.aside/u/0/telegram-bridge/bin/cloudflared
  [tunnel] starting tunnel -> http://127.0.0.1:8790
  [tunnel] tunnel url https://chairs-northern-eternal-suspended.trycloudflare.com
PARSED URL: https://chairs-northern-eternal-suspended.trycloudflare.com
tunnel stopped.
```

Nothing was registered and the process was killed immediately (`pgrep
cloudflared` → none). **No live-fire CLI turns, no Bot API calls.**

## One fix outside the listed scope

`telegram.ts`'s `stashDevInitData()` stored the whole `#initData=…` fragment
in `sessionStorage` and `readInitData()` then returned it verbatim as the
payload, so every reload after the first failed with `401 missing_hash`.
It now parses the value out before storing. This is dev-harness plumbing
only — the Telegram path never reaches it — but acceptance criterion 3 runs
through that harness, so it had to work.

## Still not done

- Attachment chips in the composer are not implemented (the `+` button is
  inert); the reference shows them on the thread screen.
- The permission label is read-only, as specified for v1.
- No commits, no pushes. Zero tracked files modified — `miniapp/` and
  `docs/` remain the only additions.

---

# Fix round — popover clamping + truthful permission/model labels

Two bugs from the Revision 2 browser E2E.

## Bug 1 — popovers opened offscreen (P0)

The popover only ever opened upward. That is right for the thread's bottom
bar, but the home screen's composer pills sit ~60px from the top, so both
menus rendered almost entirely above the viewport — the model picker showed
only "Settings", Reasoning only "Ultrabrowse".

The positioning logic is now a pure function, `web/src/utils/placement.ts`:

- Prefer the requested side (above, matching the bottom bar).
- Flip to the other side when the preferred one cannot fit the content
  **and** the other is roomier. The second condition matters — flipping into
  an equally cramped side just relocates the clipping.
- Cap height to the space actually available and let the popover scroll
  internally, replacing the old fixed `max-height: 62vh`.
- Clamp horizontally with an 8px margin. When the popover is wider than the
  viewport allows, the clamp range inverts, so it pins to the left margin
  rather than letting `Math.min` push it off the left edge.

`Popover.tsx` now renders one invisible-but-laid-out pass so it has a height
to measure, then applies the placement; it re-measures on `resize` and on
`visualViewport` resize (the on-screen keyboard fires only the latter). It
measures `scrollHeight`, not `offsetHeight`, so a re-measure of an
already-capped popover doesn't ratchet it smaller each time.

**Verified in-browser** by measuring real `getBoundingClientRect()`s:

| anchor | placement | fully onscreen | first row visible |
|---|---|---|---|
| home / model | below | yes | yes |
| home / effort | below | yes | yes |
| thread / model | above | yes | yes |
| thread / effort | above | yes | yes |

12 unit tests in `web/test/placement.test.ts` cover flip, no-flip-when-
equal, height capping, all four clamp cases and a zero-size viewport, using
the real 430×932 geometry.

## Bug 2 — permission and model misreported (P1)

The bottom bar showed the static config default ("Guard") on every session,
including sessions that were actually full-access, and the model pill always
showed the account default rather than what the session was running.

`server/src/statedb.ts` reads the truth from the daemon's SQLite database.
Three things about the real schema differ from the brief and shaped the
implementation:

1. **`permission_mode` has three values, not two.** Live distribution:
   `full-access` (139), `guard` (27), **`read-only` (4)**. Rather than
   switching on two known strings — which would have mislabelled or dropped
   the read-only sessions — the label is humanised generically
   (`read-only` → "Read only"), so a future mode renders as itself.
2. **`model` is a JSON blob**, not a bare id:
   `{"provider":…,"modelId":…,"thinkingLevel":…}`. Read raw it would have
   put JSON on the pill. It is parsed, and since `thinkingLevel` is in the
   same column the **effort** pill is now per-session too — the same
   one-line-of-truth fix, noted here because it goes slightly beyond the
   brief's "model" wording.
3. **`readOnly` must be capitalised.** node:sqlite silently ignores an
   unrecognised lowercase `readonly` and returns a *writable* handle.
   Verified against Node 23: lowercase let an `INSERT` through, capital-O
   rejected it with "attempt to write a readonly database". Given this points
   at the live daemon database, there is a test pinning both behaviours.

Access is deliberately minimal: `node:sqlite` is imported lazily (it is
experimental and absent before Node 22.5, so a static import would take the
server down on an older runtime for a nice-to-have), opened read-only, one
`SELECT` by id, closed immediately, no transaction held, cached 5s. Path
overridable via `MINIAPP_STATE_DB` or `state_db_path` in config.

Every failure path — missing file, corrupt file, absent table or column,
missing row — returns "unknown", and the client then **hides** the
permission label rather than guessing. A wrong permission label is worse
than no permission label.

The thread pills now resolve as: explicit user choice → the session's own
model → account default. Replies send that same effective model explicitly,
so a continuation stays on the model it was already using instead of being
silently switched to the account default. The picker's checkmark follows the
same value.

**Verified against the live database**, API output vs. DB truth:

| session | API | DB |
|---|---|---|
| <build-session> | Full access · Fable 5 · High | full-access / claude-fable-5 / high |
| <finished-session> | Read only · Sonnet 5 · Medium | read-only / claude-sonnet-5 / medium |
| yItJoENp…axlW | Full access · Fable 5 · High | full-access / claude-fable-5 / high |
| 0qxM3TX8…w44U | Guard · Sonnet 5 · Low | guard / claude-sonnet-5 / low |
| C1Yc0cYP…WlIH | Guard · claude-fable-5 · High | guard / claude-fable-5 / high |

The last row is a session whose provider (`bogus-provider`) is not in the
catalog: the pill falls back to the raw model id rather than inventing a
display name. With `MINIAPP_STATE_DB` pointed at a nonexistent file the
label is omitted and the thread still renders.

16 tests in `server/test/statedb.test.ts` build real fixture databases and
cover full-access, guard, read-only, no-model, missing row, missing file,
corrupt file, wrong schema, TTL caching, the open-mode footgun, and a
byte-for-byte check that the file is unchanged after a read.

## Testing

`npm test` now runs both workspaces (`--workspaces --if-present`; vitest was
added to `web`). **142 passing** — the original 114, plus 16 statedb and 12
placement. No existing test needed updating. Build and both typechecks green.

## Not done

- The window would not resize below ~1232px in the E2E environment, so the
  430px layout was confirmed via measured DOM geometry and the unit tests'
  430×932 fixtures rather than a narrow screenshot.
- The permission label remains informational; it reports the mode and does
  not offer to change it.
- `/api/status` still returns the env-derived `permission`, which now
  describes only what *new* sessions are granted. The thread bar no longer
  uses it.

---

# Round 3 — the owner's Pixel-test bugs

Six bugs from testing the live Mini App on a Pixel. Every root cause below
was confirmed against the running daemon before anything was written, and
every fix was re-checked against it afterwards.

## F1 — the `+` button does nothing

**Root cause.** It was a button with no handler. There was no upload path at
all.

**What changed.**

- The composer hides a real `<input type="file" multiple>` behind the `+`.
  Telegram's webview is an ordinary WebView, so the OS picker, the gallery
  and the camera all work without touching a Telegram API.
- Files upload the moment the picker returns, one request each, so a single
  failure costs one chip rather than the whole selection. Chips render above
  the input: a thumbnail for images, a document glyph and name otherwise,
  each with its own remove control.
- `POST /api/attachments` and `POST /api/sessions/:id/attachments`, both
  auth-gated, multipart, 20 MB/file, 5 files/message. Files land in
  `~/.aside/u/0/telegram-bridge/miniapp-uploads/<yyyymmdd>/<12 hex>-<name>`,
  directories 0700, files 0600, root overridable with `MINIAPP_UPLOADS_DIR`.
- On send the prompt is prefixed with the bridge's proven pattern:
  `[user sent 2 files from their phone, saved to: <abs>, <abs>] <text>`.

**Filename handling.** The name is attacker-controlled in the general case,
so it is reduced to its basename (POSIX *and* Windows separators), then to
`[A-Za-z0-9._-]`, with C0 controls stripped first, leading dots removed, and
a length cap that preserves the extension. Every stored file carries fresh
randomness, so nothing can collide with or overwrite anything. `..`,
`/etc/passwd`, `$(whoami).png`, NULs and newlines are all covered by tests
that assert the joined path cannot leave the root.

**The other half of the security story:** a send only accepts paths *this
server issued*. `attachments: ['/etc/passwd']` is silently dropped rather
than passed to the agent — proved end-to-end by pointing `aside_cli` at a
recorder script and reading back the child's real argv.

**Display.** The header belongs to the agent, not the reader. Left alone it
made the user's own bubble — and the session-list title — read `[user sent 2
files from their phone, saved to: /Users/…/3a385797c7f6-facts.txt, …]`. That
happened on a live run. `splitAttachmentHeader` strips it for display and
turns it back into chips, with the random prefix removed so the chip shows
the file the user actually picked.

## F2 — permission selector

A shield badge next to `+`, orange on full access. The popover mirrors
Aside's: header **Permission**, rows **Read only** (book), **Guard**
(shield), **Full access** (circled check) with a checkmark on the live one,
then a divider and a **Final confirm** row with a green switch. The
bottom-bar label is now a button that opens the same popover.

**Mechanisms, all live-tested.**

- Current state reads from `state.db` (read-only): `permission_mode` and
  `json_extract(runtime_config,'$.finalConfirm')`.
- `permissionMode` is a Zod enum of exactly `read-only | guard |
  full-access`; `'bogus-mode'` is rejected by the daemon, so the server
  validates against the same three.
- **`runtimeConfig` deep-merges.** Sending `{finalConfirm:false}` alone left
  `proactiveMode`, `strictModelSelection` and `workingDirs` intact on a
  throwaway session.

Even so the writer does read-modify-write and sends the **full** object with
one key changed. Merge semantics are an undocumented property of a
self-updating binary; a replace-shaped daemon would silently wipe the
owner's working directories, and read-modify-write is correct under both.
A test asserts no sibling key is lost.

Both fields go in one `aside.sessions.update` call so a two-field change
cannot half-apply. On the home composer the choice is held client-side and
applied right after the new session id resolves — the same create-then-update
shape the Python bridge uses.

**Honest scope, stated in the UI:** the daemon reads both when it spawns the
next `aside exec`, so a change binds from the next message. The popover says
"Applies from your next message." Nothing pretends otherwise.

## F3 — streaming and the optimistic echo

> "when a new message is sent, there is no streaming… the message is
> received all at once… also the message I send isn't viewable right away"

Three separate causes.

**1. No optimistic echo.** The sent message now appears instantly, dimmed
until the transcript confirms it. Reconciliation matches the newest user
bubble only — scanning further back would match the same question asked
earlier in the session and drop the bubble the user is waiting on — and
matches *through* the attachment header, since the stored copy contains the
typed text rather than equalling it.

**2. Refresh-only-on-complete.** Round 2's socket was a doorbell: "something
changed" arrived and the client refetched the *entire* structured thread
through the CLI facade, throttled to 1.2s. Nothing could be drawn until a
~139MB binary had returned the whole turn. That is the "all at once".

Now the server builds the thread itself — a file read, no process spawn — on
every transcript write, and pushes only the tail that changed
(`thread_delta {fromIndex, items, length}`). The diff is a first-divergence
scan, which is exactly right because thread items only ever change at the
tail. The watcher's poll floor came down from 1.5s to 800ms; `fs.watch`
normally beats it. A forced full resync on `turn_finished` closes the one
race the diff scheme has, and clients can ask for one with `resync`.

**3. True token-level streaming — investigated, and it holds, so it shipped.**

A live `aside exec` capture showed stdout mirroring the answer token by
token, in eight chunks over three seconds, while the transcript line for
that same message was not written until the whole message *and its tool
calls* had completed. The gate is not a guess about "does this look like
prose" — it is the writer's own colour state:

```
ESC[2m Thinking: … ESC[0m \n            dim   → chrome
A lighthouse is a tall tower …          plain → the answer
\n ESC[32m bash ESC[0m (command: …)\n   green → a tool call
\n ESC[2m > probe-ok ESC[0m \n          dim   → tool output
```

Anything emitted under a non-default SGR is dropped; only default-attribute
text is forwarded. Three details matter: a sequence can straddle a chunk
boundary (held, never leaked as literal `ESC[3`); a tool call's
`(command: …)` tail is emitted at the *default* attribute after the reset,
so the rest of any line that carried chrome is suppressed too; and the CLI's
status lines open with an **unstyled** `•` bullet before switching colour —
found when a failed turn put a stray `•` into a live client's answer.

Deltas are provisional and are dropped the instant the authoritative
`thread_delta` covers them.

**Measured on a live turn** (upload → new session → reply):

| event | at |
|---|---|
| `POST /api/sessions/new` returns an id | 947ms |
| socket subscribed | 968ms |
| first `thread_delta` (work fold appears) | 2973ms |
| **first `stream_delta`** | **2978ms** |
| `thread_delta` carrying the real answer | 7318ms |

The answer was readable **4.3 seconds** before the transcript had it, and
the 63 streamed characters were exactly
`Facts.txt says the metronome was invented in 1815 by Maelzel.` — no chrome,
no half-escapes. Part-level latency from a transcript write to the WS push
is asserted under 1.5s by an integration test.

**A fourth bug, found by the live run.** A session created from the home
composer has an id before it has a file — `aside exec` hands the id back as
soon as its *directory* appears. The socket answered `session_not_found`
900ms after the id was issued, so a brand new chat showed nothing live until
the user backed out and reopened it. A missing transcript is now a wait, not
an error — but only while the runner is genuinely mid-turn on that id, so a
stale link still fails immediately instead of hanging for 30s.

## F4 — "@ for context" removed

The browser's @-popover lists the user's live open tabs. That inventory
lives in the extension, not the daemon — the database only records tabs a
session has already *borrowed* — so it cannot be populated faithfully from a
phone. Per the owner's instruction the placeholders are now "Ask AI a task"
and "Reply". There was no @-handling code to remove; the pretext was the
whole of it.

## F5 — CLI/bridge sessions missing from the list

**The premise needed correcting.** The plan was to switch the list to
state.db with an `ephemeral = 0` filter. That query returns **93 rows — the
same 93 `aside.sessions.list()` already returned**, so it would have fixed
nothing.

The real cause: CLI-created sessions — the Telegram bridge's, and every
session this app itself starts through `aside exec` — are stored with
`ephemeral = 1` and the placeholder title `"Aside CLI"`. An `ephemeral = 0`
filter is *exactly what hides them*. So the shipped query does not filter on
`ephemeral` at all; it filters archived, incognito, and subagent children
(by `parent_id` and `trigger.type`, which the sidepanel also hides).

Confirmed live: a session created from the app now appears in its own list
immediately. Previously it would not have.

**A second finding worth recording:** the daemon garbage-collects ephemeral
sessions. Over one working session the table went from 179 rows (41
ephemeral) to 142 (0 ephemeral), and the CLI then reports `Session not
found` for a reaped id. So these sessions are visible while they live and
disappear when the daemon reaps them — daemon behaviour, not something this
app can or should paper over, but it explains why a chat started from the
phone may not be there tomorrow.

Placeholder titles (`Aside CLI`, `New Session`, `Untitled`) fall back to the
transcript-derived title, with the bridge's persona seed skipped and the
attachment header stripped. Unread is `read_at < updated_at`; the running
spinner comes from `status`. The facade stays as a fallback when the
database cannot be read, and a plain directory scan behind that.

## F6 — a real session rendered as one bare fold

**Root cause: the source, not the grouping rules.**
`aside.sessions.messages(id)` returns the agent's **current context**, not
the conversation. On `<build-session>` it handed back 50 messages beginning
with a `system-message` carrying a **string** body, then one user message
and a wall of tool activity — while `messages.jsonl` on disk holds 300 lines
and four separate user turns. Built from a context window, the thread
collapses into one fold with no bubbles and no answers.

The initial load now parses the full transcript from disk. The parser and
thread builder additionally handle string (non-array) `content`,
`system-message` (hidden, as the browser hides it), `toolResult` as a
top-level role, `user-message-metadata` (which *precedes* the user message
it belongs to and carries its attachments), and turns that do not start with
a user message — a post-compaction tail renders as a fold and an answer
rather than vanishing.

**Acceptance, re-checked after every later change:**

```
items: 11   kinds: {"user":4,"work":4,"answer":3}
  user  "Reference our discussion about building a telegram mini…"
  user  "1. I'm extremely dissatisfied with the UI. It looks not…"  [5 files]
  user  "let me review the changes by testing on my pixel first…"
  user  "You can test yourself on @Aside . So far I like UI, but…"  [6 files]
```

Four user bubbles, one fold per work block, every final answer, and
attachment chips on the two messages that carried screenshots.

**The compaction divider was not built.** There is no reliable marker for
it. No jsonl record identifies a compaction boundary, and the database's
`latest_compaction_message_offset` is non-zero on exactly one of 142
sessions — whose transcript is 3 lines long, so the offset (495) is not a
usable line index. A divider drawn from that would be fiction. It was a
nice-to-have conditional on a reliable marker existing; it does not.

## An incident, and the guard added because of it

Starting a second server on port 8791 for testing **repointed the owner's
production menu button at the test tunnel.** `miniapp.auto_register_menu` is
`true` in the shared config, and `setChatMenuButton` is bot-wide — it has no
notion of "which server" — so *any* instance started from that config
hijacks the live Mini App. It was corrected within minutes (and then fully
healed when the production server restarted and re-registered its own fresh
URL), but the foot-gun is real and silent from inside the process causing it.

`MINIAPP_TUNNEL=none` and `MINIAPP_AUTO_REGISTER_MENU=0` now let a second
instance opt out without editing or copying the real config, which carries
the bot token. Five tests pin the behaviour, including that menu
registration still defaults **off** when unconfigured.

## Testing

**261 passing** — 238 server, 23 web; up from 142. Build and both
typechecks green.

| suite | covers |
|---|---|
| `uploads.test.ts` (22) | sanitization, traversal, size/count caps, 0700 dirs, prompt construction, header round-trip |
| `permission.test.ts` (12) | the enum, sibling-key preservation, single-call updates, repl escaping |
| `jsonl.test.ts` (13) | string content, `system-message`, attachment metadata, compaction tails, multi-turn threads |
| `stream.test.ts` (18) | the real captured stdout chunks, split sequences, bullet lines, thread diffing |
| `round3.test.ts` (26) | upload/permission/list/thread endpoints; argv-recorded prompt construction |
| `statedb.test.ts` (27) | the list filter incl. the ephemeral case, runtime config, seconds→ms |
| `config-guards.test.ts` (5) | the tunnel and menu kill-switches |
| `integration.test.ts` (7) | part-level push latency, resync, the new-session wait |
| `web/thread-delta.test.ts` (11) | delta application, truncation, echo reconciliation |

Two pre-existing WebSocket tests were rewritten rather than repaired: they
asserted the round-2 `entries` protocol, which no longer exists. The test rig
now also points `MINIAPP_STATE_DB` and `MINIAPP_UPLOADS_DIR` at fixtures —
before this, the list endpoint under test was reading the owner's **real**
session database.

## Not done

- No compaction divider. See F6 — no reliable marker exists.
- Attachment chips show a document glyph for non-images in the *thread*;
  only the composer renders image thumbnails, since the transcript records
  a filename rather than the bytes.
- A permission change still binds on the next message, and the UI says so.

---

# Round 4 — two bugs from the coordinator's browser E2E

Both were found by driving the real UI in a browser. That distinction is the
lesson of this round, so it is worth stating plainly: round 3's tests
exercised the upload *endpoint* over HTTP and passed, while the feature was
completely non-functional for every user, because no test ever put a React
component in the loop.

## Bug A (P0) — attachments never uploaded from the real UI

**Root cause, as diagnosed and confirmed.** `useAttachments.add` pushed the
files-to-upload into an `accepted` array from *inside* a `setItems` updater,
then looped over that array on the next line. React does not run an updater
synchronously, so the loop saw an empty array and `api.upload` was never
called: chips sat at `is-uploading` forever, `fetch` was provably never
invoked, and Send stayed disabled.

**The part that made it dangerous.** It did not fail every time. React
*eagerly* computes the next state — synchronously — for the first update on
a hook whose queue is empty, purely so it can bail out if the value is
unchanged. So the first pick after a render happened to work, and every pick
queued behind another update silently did nothing. That is why it survived
casual use and why the deterministic reproduction is *two picks in one
batch*.

**Fix.** The chip list and the upload list are now computed in plain code
before any state call, and the updater is a pure `prev => [...prev,
...chips]`. No side-effect collection inside an updater, ever. The five-file
cap consequently moved to a ref, since the cap has to be known *before* the
updater runs — it decides which uploads start.

**Verified in the browser**, with `window.fetch` instrumented exactly as the
report described:

| check | result |
|---|---|
| first pick | `POST /api/attachments`, chip → ready, Send enabled |
| second pick (the deterministic failure) | 2 upload calls, 2 chips, none stuck |
| thread screen | `POST /api/sessions/<build-session>/attachments` |
| bytes on disk | both files present, 0600, contents intact |

`web/test/useAttachments.test.tsx` (12 tests) drives a real
`<input type="file">` through React and asserts `fetch` is actually invoked
and the chip reaches ready. It was checked against the *broken* code: the
headline two-picks-in-one-batch test fails reliably, as do the cap, removal
and repeat-pick tests. This needed `jsdom` + `@testing-library/react`, now
dev dependencies of `web`, and `test.environment: 'jsdom'` in the vite
config.

## Bug B (P1) — `/api/status` returning a null default

**This did not reproduce, and there was nothing to fix.** Checked against
the running production server on 8790 and a fresh instance on 8791:

```
top-level keys: …,defaults,permission
defaults:  {"provider":"claude-code","modelId":"claude-sonnet-5",
            "modelLabel":"Sonnet 5","effort":"high","effortLabel":"High"}
b.default: null      ← singular; the key does not exist
```

The payload key is **`defaults`**, plural. `b.default` is `null` because
nothing has ever been published under that name — which is exactly the value
the report quoted.

Two coincidences made this look real. The daemon's account default is
**currently `claude-sonnet-5`**, not the `claude-fable-5` seen earlier —
`aside.settings` is global and it had moved. And the bridge config's
`default_model` is *also* `claude-sonnet-5`, so "showing Sonnet 5" was
indistinguishable from "fell back to config" by inspection alone.

Confirmed in the browser that it is genuinely the daemon's value, not a
fallback: with all three `miniapp.*` localStorage keys `null`, the pills read
`Sonnet 5` / `High`, matching `/api/status` exactly. Setting a local pick
flipped them to `Fable 5` / `Extra High`; clearing it returned them to the
daemon's.

**What was actually wrong, and got fixed.** `fetchDefaultModel` had **no
test coverage at all**, which is why establishing any of the above took a
live daemon. And extracting the pill logic to test it surfaced a real defect:
the model label started at the *daemon default's* label and was only
overwritten on a catalog hit, so an explicit pick of a model the catalog does
not list displayed the daemon's model name while running the picked one. A
pill that names the wrong model is worse than no pill. `resolvePills` now
labels an explicit pick with the catalog name, else the bare model id.

New coverage:

- `server/test/round4.test.ts` (4) — `/api/status` through a stub CLI whose
  reported model differs from the config's, so the assertion can only pass if
  the value really came from the facade. Also pins that the key is `defaults`
  and that `default` does not exist, plus both fallback paths.
- `server/test/facade.test.ts` (+5) — `fetchDefaultModel`: the live payload
  shape, the exact expression sent, null handling, error propagation, caching.
- `web/test/pills.test.ts` (11) — daemon default with no pick, local pick as
  override, and the mislabel bug above.

## Testing

**293 passing** — 247 server, 46 web; up from 261. Build and both typechecks
green.

## Note for whoever tests this next

An endpoint test that passes tells you the endpoint works. It tells you
nothing about whether any user can reach it. Both round-3 escapes found here
were on the client path between a DOM event and that endpoint, and both were
invisible to every test that existed.

---

# Round 5 — six features toward the real Aside experience

Everything here was built against the owner's screenshots of the *desktop*
Aside UI and grounded in real transcripts on this machine before a line of
code was written. Where a data shape is asserted below, it was read out of a
live `messages.jsonl` or `state.db` first, not inferred.

## F1 — the work timeline is live, and settles when the answer starts

While a turn runs, the steps are on the page — one row each, spinners on the
ones still in flight — and the whole history folds into `Worked for 4s ›` the
moment the final answer begins.

**Which heuristic shipped: the streaming one.** A fold is live when its block
is `running` *and* no `answer` or `streaming` item follows it
(`foldIsLive` in `Thread.tsx`). This works because `stream_delta` starts
arriving as the answer is generated, and any `thread_delta` clears the stream
buffer — so mid-turn commentary, which is always followed by more tool calls,
briefly settles the fold and then reopens it as the next step lands. No
`turn_finished` fallback was needed. A reader can still pin the fold open or
closed with a tap; the automatic behaviour only applies until they do.

Verified live, sampling the DOM every second through a real turn:

```
t+3s   folds ["Worked for 6s", "Spawned Reply done task 4"]  open:1  spawns:2  footer "3s · ↓ 274 tokens"
t+5s   folds ["Worked for 6s", "Worked for 4s"]              open:0  answers:2
```

**Defect found by that instrumentation, and fixed.** On every send, the
*previous* turn's fold flashed back open with a spinner for ~400ms. Cause:
`buildThread` marked the last work block running whenever the session was
busy, and between `turn_started` and the new user message reaching the
transcript, "the last work block" is still the finished turn's. The rule is
now `running && isLast && !answer` — a block whose turn already produced its
answer is finished, whatever the session is doing.

## F2 — the ring is a context-window meter, not a spinner

Fill fraction is the newest assistant `usage.totalTokens` over the model's
context window. `contextWindow` is now a field on every catalog model,
defaulting to 200k with `claude-fable-5` at 1M (the owner's tooltip
screenshot reports 1000k), overridable through the same `models` config
merge. Tapping it opens Aside's own three lines:

```
Context window: 25% full
49k / 200k tokens used
Aside automatically compacts its context
```

The home composer has no session and so shows no ring. Busy-ness moved
entirely to F5; this never animates.

One subtlety worth pinning, and it has a test: a config entry that only
*renames* a model must not reset its context window to the generic default.

## F3 — streaming markdown, and citations

**(a)** The streaming buffer now goes through the same markdown renderer as
the finished answer, so there is no reflow when the transcript catches up.
The only construct that genuinely breaks half-arrived is an unterminated code
fence, which is closed for the render only (`closeOpenFence`). Unclosed
emphasis is left alone deliberately — it renders as the literal characters,
which is what it looks like in Aside too.

**(b)** `<citation refs="…">…</citation>` tags are parsed out and rewritten
into markdown plus a private `cite:` link, which renders as a tappable
superscript chip. Tapping opens a bottom sheet with the resolved sources —
title, domain, quoted passage — and each row opens the page through
Telegram's `openLink`. A `<quote>` body is lifted out of the prose and into
the sheet. Refs that resolve to nothing (some models emit local markers like
`refs="s1"`) render as clean prose with no chip, and previews strip the tags
too. A raw tag can no longer reach the screen; that invariant is tested
directly.

Two things this needed that were not obvious:

- **react-markdown sanitises hrefs.** `cite:1` is not a safe protocol, so
  every chip arrived with an empty href and rendered as plain text. Only our
  own scheme is now let past `urlTransform`; everything else still goes
  through `defaultUrlTransform`, which is what blocks `javascript:`.
- **Sources live in the children.** A session that delegates research has no
  source catalog of its own, yet its answer carries the citations naming
  those source ids. On the owner's "Aside browser" session that meant *zero*
  of 117 sources resolved from the parent alone. `buildParentView` now merges
  each subagent's catalog into the parent's. The exact citation from the
  owner's screenshot (`refs="hLQLrDqyceRyCbN-XHm36"`) now resolves to the YC
  listing.

## F4 — the subagent rendering system

`Spawned <description> ⌄` with a coloured creature glyph, and under it a
nested live card: creature, title, `✳ <model>` badge, status badge (`Running`
with a spinner / `Done` / the daemon's own word for anything else), a `›`,
the first line of the brief as a bullet, and the child's own tool rows with
`+N earlier steps` above them. Open by default while the child runs.

**Data plumbing — one deviation, stated plainly.** The task specified
`aside repl "aside.sessions.childSessions(id)"`. I verified that call returns
exactly the rows described, then used `state.db` instead: the same query,
read-only, with `parent_id = ?` and `trigger.toolCallId` pulled out of the
JSON. Two reasons. It runs on *every* thread rebuild, and the facade costs a
~139MB process spawn per call; and only the table carries the child's pinned
model, which the card shows. This is the same reasoning that already made
`state.db` the session-list source in round 3. If `node:sqlite` is missing
the join simply does not happen and spawns render as bare rows.

Children are held in a `SubagentIndex`: thread building is synchronous and
happens on every transcript write, so readers take whatever snapshot is
current and the read schedules a refresh. A refresh that changed something
emits an event the socket answers with a push.

**Second defect found by the live-fire, and fixed.** A session that has never
spawned anything looks *settled*, so the index sat on its 30s TTL and the
first spawn of a turn went unseen. `snapshot()` now also takes the parent's
own busy state and polls at 2s while a turn is in flight.

Live child steps come from tailing the child's own `messages.jsonl` through
the existing watcher registry, refcounted, attached only while a child runs
and released (with one final push) when it finishes. They arrive as
`subagent_delta` frames carrying the last 12 steps plus an honest total.

**Click-through and the composer verdict: the composer ships ENABLED.**
Tapping the `›` pushes the child's own thread onto a navigation stack — full
Thread screen, all the same machinery — with `Subagent of <parent>` under the
title, and Back returns to the parent. Sending was verified once against a
*completed child of the throwaway session*: `aside exec --session
<childId>` accepted it, the child answered, and both turns render in the
child's thread.

```
items ['user','answer','user','answer']
  user   : 'Reply with the single word "done" and nothing else.'
  answer : 'done'
  user   : 'reply with the single word ok'
  answer : 'ok'
```

**Live-fire budget: 2 turns, as allowed**, on a new throwaway session
(`claude-sonnet-5`, low effort) that spawned two subagents each time, plus
the one trivial send above to a completed child.

**Creature colours.** Hue is hashed from the spawn's `toolCallId`, so a
subagent keeps its colour across the spawn row, the card, the panel and
reloads. The first palette was hand-picked and happened to contain both 180
and 210; the two siblings in the live run landed on them and both read as
"the cyan one". The palette is now eight hues spaced 45° apart, so no two can
be confused at 16px. This is the one place in the app that uses colour, and
it is doing real work: with three subagents running, hue is how you tell
which card belongs to which row.

## F5 — the streaming footer

`⊘ 15s · ↓ 506 tokens` under the message area, only while a turn runs. The
clock ticks locally from the turn's first assistant timestamp; tokens are the
real `usage.output` (plus `reasoning`) of every assistant message completed
this turn, plus a chars/4 estimate of the buffer still streaming, snapping to
the true figure as each message lands. Observed live at `3s · ↓ 274 tokens`.

## F6a — the session panel

A panel button in the thread top bar opens a right-edge frosted sheet with
**Subagents** (creature, title, status; tap → the same child thread) and
**Files**. `GET /api/sessions/:id/artifacts` lists `artifacts/` and
`attachments/` recursively with size, mtime and a kind by extension;
`GET …/artifacts/file` serves one.

The path check is the part that matters and it has five tests: both sides are
`realpath`'d before containment is checked, which rejects `../`, absolute
paths, *and* a symlink planted inside the artifacts tree pointing elsewhere.
Symlinks are also skipped in the listing, so nothing is offered that would be
refused. Content types come from a fixed table and anything unknown is
`application/octet-stream` — never guessed, so agent output cannot become
`text/html` on our origin. Responses carry `nosniff` and a sandbox CSP, and
are capped at 25 MB.

Markdown opens in the app's own renderer with a Raw toggle, images full
width, code/text monospace, everything else a download. Inline content is
fetched as a blob so the bearer token stays in a header; only the download
path uses a `?token=` URL, which the file route accepts for the same reason
the WebSocket does — a download is issued by the OS and cannot carry headers.

## F6b — real file-write rendering

`write_file` and `edit_file` no longer show the generic tool card (the
absolute path and "Successfully wrote …", which the owner's screenshot shows
is useless). They render a diff card: filename, diffstat, copy button, and
line-numbered content with green-tinted additions and red removals.
Markdown files get light regex tinting of headings, bold, emphasis, links and
inline code — no highlighter dependency for four accents on a phone.

The card is open while the write is in flight and folds to its row when the
result lands, unless the reader has opened it themselves. Verified against
the real artifacts: `ai-news-models-products.md +27 -0`, 27 numbered lines.

**Honest limitation.** Aside's card grows *as the write streams*. Ours cannot:
a transcript line only lands complete, so the card appears fully populated at
the moment the call is written, then collapses on the result. The open/close
behaviour is right; the intermediate growth is not available to us.

**A third bug, found because subagent cards made it visible.** Every web
search rendered as "Searched the web". The tool's argument is `objective`,
not `query` — verified in live transcripts, and it is what the desktop app
quotes in the row. One search per fold hid it; four in a subagent card did
not.

## Testing

**357 passing** — 286 server, 71 web; up from 293. Both typechecks and the
build green.

New coverage: citation parsing and resolution (including the never-a-raw-tag
invariant across resolvable, unresolvable and quote-wrapped forms), the
partial-tag and unclosed-fence streaming guards, the fold-settle rule,
context-window maths and the catalog merge (including the rename case),
spawn↔child join by `toolCallId` and its negative case, `SubagentIndex`
change detection / degradation / busy-TTL, `subagent_delta` plumbing against
a fixture child transcript, artifact listing, traversal and symlink
rejection, content types, diff parsing for both write and edit in both
before- and after-result states, turn-token accounting, and the compact
formatters.

Invalidated expectations updated rather than worked around: the `StateDb`
shape gained `parentId` (the read is now `SELECT *`, so a database missing a
newer column still yields the ones it has), catalog models gained
`contextWindow`, the filesystem-listing test gained the two new fixtures, and
the "marks a live turn as running" fixture now stops before its answer,
because that is what a live turn actually looks like.

## Not done

- The file-write card cannot grow during the write; see F6b.
- Subagent cards show the last 12 steps and summarise the rest. The cap is
  deliberate and the total is reported honestly.

---

# Round 6 — two reported bugs, and everything the repo needs to go public

The last build round. Two bugs the owner hit on real screens, then the work
that turns a directory of source into something a stranger can clone.

## Bug A — images in an answer rendered as a broken icon

The report came with a screenshot: an assistant answer containing
`![…](<absolute local path>)` drew the browser's broken-image glyph, while
the same screenshot displayed perfectly inside the expanded work timeline a
few pixels below it.

The split is the diagnosis. Timeline images arrive as data URIs in the
transcript itself — self-contained, nothing to fetch. Answer images are
markdown pointing at a path on the Mac, and the webview on the phone has no
filesystem to resolve it against. The agent is writing correct markdown for
a reader sitting where it is; the reader is somewhere else.

**Server** — `GET /api/sessions/:id/file?path=<abs>&token=`, in a new
`localfiles.ts`. It reuses the artifact route's hardening rather than
inventing a second, looser set:

- `realpath` on both the roots and the target before the containment check,
  so `../` and a symlink planted inside a root are the same refusal;
- exactly three allowed roots — that session's own directory, the Mini App
  uploads directory, and the bridge's Telegram media directory. Those are
  the three places an image an answer can legitimately name actually lives.
  An absolute path anywhere else is a 403, including another session's
  directory and `config.json`;
- a content-type table that is **images only**. The artifact route serves
  markdown and code; this one is reached from an `<img>` tag, so a
  non-image inside an allowed root is still refused;
- 10 MB cap, `nosniff`, `sandbox; default-src 'none'`, `private, no-store`;
- `?token=` accepted (a tag cannot set a header) and covered by the H-2
  query redaction already in the logger.

**Web** — `localImagePath` decides what is local: an absolute path or a
`file://` URL is rewritten onto the route with the session's token;
`https:`, `data:`, `blob:` and protocol-relative srcs are passed through
untouched. Relative paths are deliberately *not* rewritten — resolving one
would mean guessing a base directory on the agent's behalf. Anything that
fails, is refused, or has no session to resolve against renders a small
"Image unavailable" caption instead of the broken glyph. The same rewrite
runs in the artifact markdown viewer.

Images are `loading="lazy"`, so an answer with a dozen screenshots costs
nothing until they scroll into view. The H-6 transcript budgets are about
payload size and do not apply to these; the route's own 10 MB cap does.

**Tests** (server 15, web 12 for this bug): the artifact attack-string suite re-run
against the new route plus the attacks only an absolute path can express
(another session's transcript, the config, the JWT secret, a NUL suffix, a
symlink out of a root), the size cap, the auth matrix, and on the web side
the rewrite table, the failure caption, and the proof that `javascript:` is
still refused in an ordinary link. One of those is a reconciliation guard:
react-markdown uses the `components` map entries *as element types*, so an
arrow written inline there is a new type on every render — it unmounted and
remounted every image, losing the "this one failed" state and re-requesting
the file several times a second on a streaming answer. The renderer is
memoised on `sessionId`, and the test fails if it is inlined again.

Verified live against a throwaway instance on 8791 (`MINIAPP_TUNNEL=none`,
`MINIAPP_AUTO_REGISTER_MENU=0`, stopped by pid afterwards), on the owner's
real files:

```
media/ image (bridge photos)         -> 200  image/jpeg 172210 bytes
media/ image via ?token= (an <img>)  -> 200  image/jpeg 172210 bytes
miniapp-uploads/ image               -> 200  image/png  458735 bytes
bridge config.json (holds the token) -> 403  unsupported_type
miniapp-secret.json (JWT key)        -> 403  unsupported_type
/etc/passwd                          -> 403  unsupported_type
another session's transcript         -> 403  unsupported_type
traversal out of the session dir     -> 403  unsupported_type
a real .png outside every root       -> 403  forbidden_path
symlink inside media/ -> outside     -> 403  forbidden_path
symlink inside media/ -> config.json -> 403  forbidden_path
relative path                        -> 400  bad_path
no token                             -> 401
```

## Bug B — two subagents could get the same colour

The creature hue was `hash(toolCallId) % 8`. With five siblings that
collides about 60% of the time, and the colour exists precisely so you can
tell sibling cards apart — a colour two cards share is worse than no colour.

Slots are now handed out **sequentially in spawn order**, counted across
the whole session rather than per turn, so a spawn in turn 4 cannot land on
the colour a still-visible sibling from turn 1 has. Spawn order comes from
the transcript, so it is exactly as stable across reloads as the hash was.
The server assigns the slot; the client only maps slot → hue, which is what
keeps the spawn row, the card, the panel and the child header identical by
construction. A child whose spawn is no longer in the transcript still gets
a slot, after the ones that are.

Test: ten spawns in a fixture transcript → slots `0..7` distinct, then
wrapping `0, 1`; identical on a second build; and the child list carries the
slot of the spawn that created it, not its own position in the daemon's
list.

## bridgemon — diagnosed, fixed, and extended to both services

`bridgemon status` was run read-only against the real machine first. What
was wrong:

1. **`monitor.py` hardcoded the label while `bridgemon.py` detected it.**
   `LABEL = "com.aside.telegram-bridge"` and a matching plist path, against
   a detector that also knows the legacy `com.saiamartya.*` label. On this
   machine — and every install predating the public rename — `bridgemon
   watch --status` reported STOPPED for a live bridge, `--kill` booted out a
   service that did not exist, and `--start` bootstrapped a plist that was
   not on disk. All three failed silently. There is one detector now, and
   monitor.py imports it.
2. **`_is_git_repo()` used `os.path.isdir('.git')`.** In a git worktree
   `.git` is a *file*, so a worktree install took the "local-only mode"
   path and never updated.
3. **Label detection ran at import time**, shelling out to `launchctl`
   up to four times for `bridgemon logs` — and for anything that merely
   imported the module. It is cached and lazy now.
4. **`bridgemon logs oops` died with a `ValueError` traceback.**
5. **No `--help`.** `bridgemon --help` / `-h` / `help` all print the usage.

Extended, so the whole system is one CLI:

- `bridgemon status` reports both services: bridge label, running state and
  pid; Mini App service state, pid, port, live health check, tunnel URL
  parsed from its logs, and last error. "waiting…" is only printed when
  there is a log to wait on — with no log at all it says so and names the
  path, rather than reporting a guess as a state.
- `bridgemon miniapp status | start | stop | restart | logs [n]`.
- `bridgemon update` now, when a Mini App config or service is present,
  snapshots `server/dist` and `web/dist`, runs `npm install && npm run
  build`, restarts `com.aside.miniapp` and health-checks it — restoring the
  snapshot and restarting again if any of that fails. A failed build never
  reaches a restart. The snapshot exists because vite empties its outDir, so
  a build that dies halfway leaves the service serving nothing.
- `BRIDGEMON_DIR` / `BRIDGEMON_CONFIG` point the tool at an install
  elsewhere, which is how the status below was taken from a checkout, and
  how the tests run against a throwaway tree.

Existing behaviour is unchanged: `watch`, `update`'s bridge path, its
rollback rule, `rollback`, `logs`, `init`. Nothing was restarted to test
this; verification was `--help`, read-only `status`, and 42 offline checks
in `tests/test_bridgemon.py` covering label detection (including the stale-
plist case that caused the original bad auto-rollback), the worktree fix,
the argument parse, the config readers, and the dist snapshot/restore.

Read-only status against the real install:

```
$ BRIDGEMON_DIR=~/.aside/u/0/telegram-bridge python3 bridgemon.py status
bridge service: com.saiamartya.aside-telegram-bridge
running:  False
last-good backup: yes

mini app service: com.aside.miniapp
running:  no launchd plist (started by hand?)
port:     8790 (health ok)
tunnel:   unknown (no mini app log at ~/.aside/u/0/telegram-bridge/miniapp.log)
menu button auto-register: on

last log lines:
  … bridge starting. session=<session-id> model=claude-fable-5 owner=<owner>
```

Truthful, and worth reading closely: the bridge launchd job is **not
loaded** on this machine right now (`launchctl print` cannot find it, and
no `bridge.py` is running), and the Mini App is running from a checkout
rather than from its service. Both are states the old status could not have
told apart from "fine".

## Setup, for someone who has never seen this repo

`setup.py` ends with an optional step that hands off to
`miniapp/setup-miniapp.py`, passing the config path it just wrote. Declining
leaves a working bridge; a Mini App setup that fails cannot fail the bridge
install that already succeeded.

`setup-miniapp.py` was reviewed against the fresh-clone case and is
idempotent: Node 20+ check with install guidance, `npm install && npm run
build`, config keys written in place (chmod 600 preserved), the
`com.aside.miniapp` plist booted out and back in, a health check, and the
tunnel URL printed. `auto_register_menu` is still **off unless asked**, and
the prompt now explains what it costs: the menu button is bot-wide, so
turning it on takes the button away from any other machine on the same bot
token. It also offers to use a `cloudflared` you already have.

## Audit M-6 — the cloudflared download, fixed rather than documented

The audit left this open: the binary was fetched from
`releases/latest/download`, `chmod 755`'d and executed with HTTPS to
github.com as the only control, so what ran changed without notice.

Cloudflare still publishes no digest file with its releases — verified
against the current release, 26 assets, none of them a checksum list. So the
digests were computed the only honest way: each asset downloaded over HTTPS
and hashed. `server/src/cloudflared-release.json` pins the release tag and
carries the SHA-256 of every asset this server will fetch, with the command
to regenerate them in the file itself.

At runtime the asset is written to a `.part` file, hashed, and only renamed
into place on a match; a mismatch deletes the partial and throws. There is
no flag to skip the check. The way past it is
`MINIAPP_CLOUDFLARED_PATH` or `miniapp.cloudflared_path` — your own binary,
an explicit choice rather than a silent downgrade — and the error message
names both. A platform with no vendored digest fails closed the same way. A
marker file records what a downloaded binary was verified against, so a
moved pin is visible rather than silent.

## Public-repo hygiene

`.gitignore` rewritten with a comment per group and verified with `git
check-ignore` against each path it is supposed to cover: `config.json` (and
`config.json.*` backups), `state.json`, `state.db`, `miniapp-secret.json`,
`.env*`, all logs, `media/`, `miniapp-uploads/`, `bin/` (the cloudflared
binary and its marker), `backups/`, `node_modules/`, `dist/`, `__pycache__/`.

Every file that would be committed — 126 of them — was swept. Patterns, and
what they found:

| pattern | before | after |
|---|---|---|
| bot token, exact value from `config.json` | 0 | 0 |
| bot-token shape `\d{8,10}:[A-Za-z0-9_-]{35}` | 0 | 0 |
| owner's chat id, exact | 0 | 0 |
| live session id from `config.json`, exact | 0 | 0 |
| JWT (`eyJ….…`) | 0 | 0 |
| private-key block / AWS access key | 0 | 0 |
| owner's absolute macOS home path | 2 | **0** |
| real session ids (3 distinct) | 5 | **0** |
| owner's real session titles | 2 | **0** |
| phone numbers | 0 | 0 |
| email addresses outside `example.com` | 0 | 0 |

The five hits were all in `docs/`: two absolute paths in the build report,
`<build-session>` / `<finished-session>` / `<largest-session>` in place of
three real ids across both docs, and one line of real session titles now
described rather than quoted. `0qxM3TX8G2zcw44U` is deliberately kept — it
is the throwaway session this project's own live-fire tests created, and the
transcript excerpts around it are the evidence for those tests. Technical
content is otherwise unchanged.

Two things were found, looked at, and deliberately left:

- `com.saiamartya.aside-telegram-bridge` appears in `bridgemon.py`,
  `monitor.py` and the bridgemon tests. It is a launchd label the detector
  has to match literally for every install predating the public rename, and
  the handle is the repo owner's public one.
- The `## What it feels like` example in the README reads like somebody's
  actual day. It predates this round and is the owner's own published copy,
  so changing the product's voice was not this round's call — flagging it
  is.

## Testing

```
server: 345 passed (345)   # +22 this round (15 round-6, 7 cloudflared)
web:     95 passed (95)    # +12 this round
bridgemon: 42 checks, 0 failed
typecheck + build: green
py_compile on every touched Python file, bash -n install.sh: green
```

## Not done

- The tunnel URL in `bridgemon status` is parsed from the Mini App's log
  files. A server started by hand logs to its terminal, so there is nothing
  to parse; the status says exactly that rather than guessing.
- The pinned cloudflared is not auto-refreshed. Moving the pin is a
  deliberate edit to `cloudflared-release.json`, which is the point.
- An already-downloaded binary from before this round is reused rather than
  re-fetched. Replacing a working tunnel binary on upgrade is a worse
  failure mode than running a slightly older cloudflared; the log says which
  pin it was verified against, or that it predates verification.
