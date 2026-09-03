# Independent audit — Aside Telegram Mini App

**Scope:** everything under `miniapp/` (Fastify + `ws` TypeScript server, React 19 SPA).
**Auditor:** an agent that did not write this code.
**Date:** 2026-07-27.
**Premise:** the whole tree was produced by AI workers across five build rounds and is
about to ship publicly behind a Cloudflare tunnel. Surface quality is high everywhere —
long explanatory comments, plausible-sounding rationales, ~300 tests. That is exactly the
condition under which reading is not enough, so wherever a claim could be checked it was
checked by running something, not by reading the comment that asserted it.

Everything under **Findings** was reproduced before it was fixed. Everything under
**Verified clean** was attacked or measured and held.

---

## 1. What this audit actually did

| Method | Coverage |
| --- | --- |
| Full read of server source | 20/20 files, exhaustive |
| Full read of web source | `api.ts`, `telegram.ts`, `useThread.ts`, `useAttachments.ts`, `Markdown.tsx`, `FileViewer.tsx`, `WorkFold.tsx`, `types.ts` read in full; the other 14 components skimmed for the concerns in the checklist (auth, injection, resource lifetime) — **sampled, not exhaustive** |
| Live attack probes against the built server | 8 probe suites, ~40 assertions (traversal, symlink escape, rate limiting, auth coverage, content types, secret leakage, DB write attempts, WS flooding) |
| Race reproduction against `TurnRunner` | 6 scenarios driven with a fake child process |
| Real-transcript validation | **60 real transcripts, 280 MB, 7 515 messages** from `~/.aside/u/0/sessions` (2 250 sessions on disk, 1.8 GB) run through the production parser + thread builder, read-only. No content copied into the repo |
| Mutation testing of the existing suite | **28 mutations** across 12 source files; **8 survived** (see §4) |
| `npm audit` | 0 vulnerabilities, prod and dev |
| Dependency reality check | every import resolved against `node_modules`; every declared version matches what is installed |

**Honest limits.** The 14 unread components, the CSS, and `setup-miniapp.py` were not
reviewed line by line. Mutation testing sampled 28 of ~360 mutable decision points. The
Telegram WebApp SDK surface was checked against the fields the code declares, not against
a live client. No live `aside exec` turn was run, as instructed.

---

## 2. Findings

Status key: **FIXED** = changed and covered by a regression test that fails without the fix.
**DOCUMENTED** = left in place deliberately, with the reason.

### Critical / High

| ID | Sev | Where | Finding | Repro | Status |
| --- | --- | --- | --- | --- | --- |
| **H-1** | High | `server/src/app.ts:98` (`trustProxy: true`) | **Rate limiting was completely bypassable.** `trustProxy: true` makes `request.ip` the leftmost `X-Forwarded-For` value, and `@fastify/rate-limit` keys its buckets on `request.ip` — so every limit in the file had a key the caller chose. This is the server's only brute-force control, on a public tunnel. | 30 POSTs to `/api/auth` with a rotating `X-Forwarded-For` → **0 responses were 429** (limit is 10/min). | **FIXED** — `trustProxy: false` plus an explicit `keyGenerator` reading the raw socket address, so no header can influence the bucket. Either change alone closes it; both are in. Test: `A-1`. |
| **H-2** | High | `server/src/app.ts` artifact route + Fastify default logger | **Live bearer tokens written to disk in cleartext.** `/api/sessions/:id/artifacts/file` accepts `?token=<jwt>` (a download can't send a header), and Fastify's default `req` serializer logs `req.url` verbatim — so every artifact download wrote a valid 24-hour session JWT into `miniapp.log`. | Probe P2: log line contained the full 188-char token. | **FIXED** — a `req` serializer that truncates the query string to `?<redacted>`. Test: `A-2`. |
| **H-3** | High | `server/src/ws.ts` upgrade handler | **The WebSocket was an unauthenticated, unlimited open door.** The upgrade is a raw `server.on('upgrade')` listener, so it sits outside Fastify routing *and* outside the rate limiter. A socket that connected with no `?token=` and then said nothing was accepted and held open forever — each one registering 4 listeners on the runner's emitters. | 200 tokenless upgrades issued in ~1 s → **200 accepted**, all still OPEN after 1.6 s. | **FIXED** — 5 s authentication deadline (then close + terminate), and the upgrade is refused with 503 past 32 concurrent clients. Tests: `A-3`. |
| **H-4** | High | `server/src/exec.ts` `createSession` | **A new session could be wedged permanently.** If the CLI created its directory and then exited before the 300 ms discovery poll noticed, `trackChild`'s cleanup ran with `discovered` still `null`, and the code then set `queue.running` anyway. Nothing ever cleared it: the session reported busy forever, every later send queued behind a turn that had already finished, and `/api/status` showed a phantom in-flight turn. | Probe R1: `isBusy` = `true` after the child had closed; follow-up send queued and never spawned. | **FIXED** — the child's settled state is tracked, and a turn that finished during discovery takes the release path instead of the running path. Test: `B-1`. |
| **H-5** | High | `server/src/exec.ts` `createSession` | **Concurrent creates cross-assigned session ids, and a session created by the Python bridge could be hijacked.** Discovery snapshotted the sessions directory, polled for a new name, sorted, and took the last — with no lock and no claim. Two overlapping creates both returned the *same* id (two turns on one session, one session's replies attributed to the other). Worse in production: `bridge.py` runs 24/7 against the same directory, so a session it created during the poll window was claimed by the mini app. | Probe R2: A and B both returned `zzzzzzzz`. Probe R3: a directory created by a third party was returned as ours. | **FIXED** — discovery is serialised through a promise chain, and a claimed-id set plus a busy check stop a second discovery taking a directory that is not its own. Tests: `B-2`. **Residual, documented:** the id still comes from a filesystem race, so a session the Python bridge creates in the exact poll window can still be mis-attributed. Closing that fully needs the CLI to report its own session id; see §5. |
| **H-6** | High | `server/src/thread.ts` `imageParts` | **Unbounded base64 images inlined into thread items.** Every field in a thread item is capped (`OUTPUT_LIMIT` 4 000, `FILE_LINE_LIMIT` 400) except images, which were copied verbatim from the transcript. Consequences on a real session: the `/thread` REST response *was* the image payload, every socket resync re-sent it, and `firstDivergence` re-serialised it on every 150 ms push. | Measured on `~/.aside/u/0/sessions/<largest-session>` (57 MB transcript): **58.1 MB of data URIs across 91 images in 35 items**; thread JSON 59.1 MB; `firstDivergence` **176 ms of blocking CPU against a 150 ms throttle** — an event loop that can never catch up while a client is subscribed. | **FIXED** — per-image (256 KB), per-step (3) and **per-thread (6 MB)** budgets, newest steps keeping their images; dropped images are reported to the client, which now renders "N more images not shown" rather than silently showing fewer. **Same session after the fix: 5.98 MB, worst-case diff 34 ms, 0 ms on the cached path.** Tests: `B-6`, `C-4`. |
| **H-7** | High | `threadstore.ts`, `sessions.ts`, `statedb.ts`, `facade.ts`, `subagents.ts`, `exec.ts`, `app.ts` | **Six unbounded caches in a process designed to run for weeks.** Every one is keyed by session id or file path, against a directory holding 2 250 sessions. `ThreadStore` is the severe one: an entry is a whole parsed thread, and a single real 57 MB transcript costs ~180 MB of retained heap — opening a handful of large threads sits on gigabytes nothing releases. `uploadTokens` additionally kept the uploaded *bytes* on disk forever. | `readHistory` on the 57 MB transcript: 175 ms, **182 MB heap delta**, retained indefinitely. Probe R5: `TurnRunner.queues` grows one entry per session id ever seen. | **FIXED** — LRU bounds on all six (`ThreadStore` 16, scan cache 300, state/facade/subagent 256, idle runner queues 256), and upload receipts age out after 6 h with their bytes removed. Tests: `B-8`, `B-9`. |

### Medium

| ID | Sev | Where | Finding | Status |
| --- | --- | --- | --- | --- |
| **M-1** | Medium | `server/test/config-guards.test.ts` | **The test suite failed under the project's own documented test command.** The file read `MINIAPP_TUNNEL` / `MINIAPP_AUTO_REGISTER_MENU` off the ambient environment, so running with `MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0` — the exact command the project mandates so a test run cannot repoint the live bot — failed 1/286. The suite was only green when run in a way the project tells you not to. | **FIXED** — each case saves, clears and restores the variables it is about. |
| **M-2** | Medium | `server/src/config.ts:239` → `exec.ts` | **A non-numeric `exec_timeout_seconds` killed every turn instantly.** `Number(raw.exec_timeout_seconds \|\| 1200) * 1000` is `NaN` for any non-numeric config value, and `setTimeout(fn, NaN)` fires on the next tick — so every `aside exec` was SIGTERMed the moment it started, indistinguishable from the CLI failing. Reproduced (probe R6). | **FIXED** — `execTimeoutMs()` falls back to 20 min for any non-finite or non-positive value. Test: `B-4`. |
| **M-3** | Medium | `server/src/exec.ts:343` | **Repl code built by string concatenation.** `aside.sessions.update('${sessionId}', …)` was the only repl call site in the codebase not using a JSON literal — every other one goes through `lit()`/`JSON.stringify`. Not exploitable today (the id comes from a directory name and is validated), but this is the shape that becomes RCE against the daemon the day the id's provenance changes. | **FIXED** — `grantFullAccessExpression()` uses `JSON.stringify`, with an escaping test. Test: `B-5`. |
| **M-4** | Medium | `server/src/exec.ts` `shutdown` | **Orphaned child process on shutdown.** A `createSession` whose directory had not appeared yet has no queue entry, so `shutdown()`'s loop over `queues` walked straight past it and left an `aside exec` running after the server had gone. Reproduced (probe R4). | **FIXED** — pending create-session children are tracked and reaped. Test: `B-3`. |
| **M-5** | Medium | `server/src/app.ts` `/messages` | **Whole-transcript read into memory, per request, on a route with no client.** `fs.readFileSync` runs before `afterLine` or `limit` can apply — 163 ms and ~180 MB for a real 57 MB session. Nothing in the SPA calls this route (rounds 1–2 polled it; round 3 replaced it with server-built deltas). | **FIXED (bounded)** — 413 past 32 MB. The route itself is kept: it is a useful debugging affordance and removing a served endpoint is not an audit's call. Marked as such in `web/src/api.ts`. |
| **M-6** | Medium | `server/src/tunnel.ts` `ensureCloudflared` | **A binary is downloaded from the network, `chmod 755`'d and executed with no integrity check.** HTTPS to `github.com` is the only control; there is no checksum or signature verification, and no pinned release — the URL is `.../releases/latest/download/...`, so what runs changes without notice. | **FIXED (round 6)** — the release tag is pinned and every asset's SHA-256 is vendored in `server/src/cloudflared-release.json`. Cloudflare still publishes no digest file (re-verified against the pinned release: 26 assets, none of them a checksum list), so the digests were computed by fetching each asset over HTTPS and hashing it; the file carries the command to regenerate them. The download is written to a `.part` file, hashed, and only renamed into place on a match — a mismatch deletes the partial and throws, and there is no flag to skip the check. A platform with no vendored digest fails closed the same way. The way past a failure is your own binary via `MINIAPP_CLOUDFLARED_PATH` or `miniapp.cloudflared_path`, which the error message names. Tests: `cloudflared integrity (M-6)`. |
| **M-7** | Medium | `server/src/app.ts` artifact route | `fs.statSync(file)` could throw between the resolve and the read (the agent owns that directory and may be rewriting it), turning a vanished file into a 500. | **FIXED** — 404. |
| **M-8** | Medium | test suite | **Eight coverage gaps found by mutation** — see §4 for the full table, including two security guards that were entirely unasserted. | **FIXED** — new tests in `server/test/audit.test.ts` and `web/test/audit.test.tsx`; each was verified to fail against the mutation it guards. |
| **M-9** | Medium | `server/src/statedb.ts:14–18` + `test/statedb.test.ts:66` | **A comment claimed a test that did not exist.** `statedb.ts` documents `readOnly` (capital O) as load-bearing — lowercase `readonly` is silently ignored by `node:sqlite` and yields a *writable* handle against the owner's live daemon database — and states "There is a test pinning this." The test that exists constructs its own `DatabaseSync` and asserts `node:sqlite`'s behaviour; it never touches `StateDb`. Changing the production call to the footgun spelling passed all 286 tests. | **FIXED** — the options are now a named exported constant used by production and asserted directly, so the mutation fails. Test: `A-6`. |

### Low

| ID | Where | Finding | Status |
| --- | --- | --- | --- |
| L-1 | `thread.ts` `flushTurn` | **A vacuous condition dressed as a real one.** The answer-promotion loop looked like it examined the turn's tail (`work.slice(i+1).every(w => w.kind === 'text')`), but both branches `break` on the first iteration, so it only ever saw the last item and the guard's slice was always empty and always true. Mutating it to `if (true)` changed nothing and broke no test. | **FIXED** — rewritten as what it does (four lines), with tests for both directions. |
| L-2 | `useThread.ts` `applyDelta`, `artifacts.ts` `listArtifacts`, `app.ts` upload cap | **Three more guards that are dead or redundant in practice** — the delta-truncation branch cannot fire on a well-formed server delta; the `isSymbolicLink()` skip is already covered by the `isFile()` check on the next line; the explicit upload-size check never runs because `@fastify/multipart` throws first (contradicting the comment above it, which says it does not). All three are correct defence-in-depth. | **DOCUMENTED + now tested** at the behavioural level, so the property survives even if the belt or the braces go. |
| L-3 | `app.ts`, `facade.ts`, `threadstore.ts`, `web/src/api.ts` | Dead exports: `defaultWebDist`, `fetchMessages` (round-1 leftover pointing at the facade path round 3 abandoned), `childSteps` (duplicated inline in `buildParentView`), `hasAuthToken`. | **FIXED** — removed. |
| L-4 | `watcher.ts` | `SessionWatcher` runs the full `TranscriptParser` on every transcript write and emits `entries` — **both consumers in `ws.ts` ignore the payload** (`const onEntries = () => schedulePush()`), and the `lastLine` getter has no callers. The parse is pure waste on the hot path. | **DOCUMENTED** — not fixed. Removing it changes `SessionWatcher`'s public contract and the tests that cover it; it is a clean follow-up, not an audit edit. |
| L-5 | `transcript.ts` / `jsonl.ts` / `sessions.ts` | **Three parallel transcript readers** (`TranscriptParser`+`parseTranscript`, `parseHistory`, `scanTranscript`), one per round. Only `parseHistory` is on a live path; the other two survive on the dead `/messages` route and the session-list scan. | **DOCUMENTED** — consolidation is a refactor, and L-4/M-5 are its prerequisites. |
| L-6 | `subagents.ts` `refresh` | `if (existing) existing.refreshing = true` — the in-flight guard cannot apply on the *first* read of a parent, so two concurrent first reads both hit SQLite. Harmless (idempotent read), but the guard does not do what it reads as. | **DOCUMENTED** |
| L-7 | `app.ts` `/api/sessions/new` | The 502 body echoes `(err as Error).message`, which for a spawn failure is `spawn /Users/<user>/.aside/... ENOENT` — a local path in a response body. Owner-only (the route is authenticated), so informational rather than a leak. | **DOCUMENTED** |
| L-8 | `sessions.ts` `resolveSessionDir` | `readdirSync` over the whole sessions directory (2 250 entries) on **every** call, and it is called per route, per WS poll tick, and once per subagent in `buildParentView`. Measurable but not currently a bottleneck next to the fixed items. | **DOCUMENTED** |
| L-9 | `tunnel.ts` `assetFor` | Any darwin arch that is not `x64`/`x86_64` gets the arm64 asset, including `ia32`. Unreachable on supported hardware. | **DOCUMENTED** |
| L-10 | `ws.ts` | Each connection adds 4 listeners across two emitters; the default `maxListeners` of 10 produced a spurious "possible EventEmitter memory leak" warning at 3+ clients. | **FIXED** — raised to the real bound (`MAX_CLIENTS + 10`). |

---

## 3. Verified clean

These were attacked or measured, not just read. Each held.

**Path traversal and symlink escape (`artifacts.ts`) — clean, and genuinely well built.**
Nine attack strings were fired at the live artifact route with a valid token, against a
session directory seeded with a symlink to a file outside it and a symlinked directory
pointing at the test root:

```
../../../../etc/passwd            → 403      /etc/passwd                   → 403
..%2f..%2f..%2fetc/passwd         → 403      ../attachments/note.txt       → 403
a/../../../../../../etc/passwd    → 403      escape.txt   (symlink)        → 403
./././../../../../../../etc/hosts → 403      rootlink/SECRET.txt (symlink) → 403
..\..\..\etc\passwd               → 403
```

The listing endpoint named neither symlink. The `realpath`-both-sides-then-contain check
in `resolveArtifact` is the correct construction, and `isValidSessionId` (`^[A-Za-z0-9_-]{1,128}$`)
means no caller-supplied string reaches a path join in the first place.

**Auth coverage — clean.** All 11 routes enumerated from the live router and probed
without credentials: `/api/sessions`, `/:id/thread`, `/:id/messages`, `/:id/artifacts`,
`/:id/artifacts/file`, `/api/status`, `/api/sessions/new`, `/:id/send`, `/:id/permission`,
`/:id/attachments`, `/api/attachments` — **every one returned 401**. No route added in a
later round forgot the hook. Only `/api/health` and `/api/auth` are open, correctly.

**Post-audit routes — not re-probed.** Since this audit, new authenticated routes were
added without a repeat of the credential-less probe: `/api/sessions/:id/stop`,
`/api/sessions/:id/answer`, `/api/sessions/:id/recover`, `/api/projects`,
`/api/sessions/:id/file`. All are registered with the same `requireAuth` preHandler
(the two file-download routes use `requireAuthOrQueryToken`, which the H-2 fix already
covers). They have not been through the adversarial probing below; treat that gap as
known when extending auth or token handling.

**Served content types — clean.** `.html` and `.xhtml` are served `application/octet-stream`;
`.svg` gets `image/svg+xml` but every response carries `content-security-policy: sandbox;
default-src 'none'` plus `x-content-type-options: nosniff` and `cache-control: private,
no-store`, which neutralises script in a top-level SVG. The client additionally fetches
artifacts as blobs and renders images through `<img>`, where SVG script never executes.

**Markdown rendering — clean.** No `rehype-raw`; raw HTML in transcript text is not
rendered; `urlTransform` passes only the app's own `cite:` scheme and sends everything else
through react-markdown's sanitiser (`javascript:` and `data:` hrefs are blanked). This was
*untested* before — see C-3 — but it was correct.

**SQLite access — clean.** Every query is parameterised (`?` placeholders, no string
building anywhere); the handle is opened `readOnly` and closed in a `finally`; a write
attempt on such a handle throws `attempt to write a readonly database`; a full read cycle
(`read` + `list` + `children`) left the fixture table byte-identical.

**Child-process spawning — clean.** `spawn`/`execFile` with argv arrays everywhere; no
shell string, no `shell: true`, no user text reaching a flag or a path. Prompt text is a
positional argument. The only place building code as a string was M-3, now fixed.

**Filename sanitisation (`uploads.ts`) — clean.** Basename reduction, C0-control strip,
`[A-Za-z0-9._-]` allowlist, leading-dot strip, length clamp, and a 12-hex random prefix so a
chosen name can neither collide nor overwrite. Directories 0700, files 0600.

**Attachment allowlist — clean.** Only paths this server issued are accepted on a send;
`{"attachments": ["/etc/passwd"]}` is dropped, not read out to the agent.

**Secrets — clean after H-2.** The bot token is used for exactly one thing (the initData
HMAC) and never logged, never in a response, never in an error body. The JWT secret is
generated with `crypto.randomBytes(32)`, stored `chmod 600` outside the repo. The startup
log line deliberately carries no token, secret or user id. Auth failure bodies return an
opaque reason code.

**initData validation — clean.** Delegated to `@telegram-apps/init-data-node` (the real
HMAC-SHA256-over-sorted-fields spec), with a 15-minute freshness window, platform-agnostic
field handling, and an owner allowlist enforced both at mint time and again on every token
verification (so revoking the id in config takes effect immediately rather than in 24 h).

**The transcript parser against the real schema — clean.** 60 real transcripts (280 MB,
7 515 messages) run through `parseHistory` → `buildThread` → `threadStats` →
`collectSources` → `parseTranscript` → `scanTranscript`:

- **0 crashes.**
- **0 dropped user bubbles** — every `role: "user"` line produced a bubble.
- **0 text loss** — assistant text parts always equalled answers + fold commentary.
- **0 step loss** — `toolCall` parts always equalled rendered steps.
- Corrupt/partial JSONL lines were skipped, not fatal; the trailing partial-line rule held.
- Every role present in real data (`assistant`, `toolResult`, `user`, `system-message`,
  `user-message-metadata`) is handled or deliberately ignored.

**Dependencies — clean.** Every import resolves; every `package.json` version matches what
is installed (`fastify` 5.10.0, `ws` 8.21.1, `jsonwebtoken` 9.0.3,
`@telegram-apps/init-data-node` 2.0.10, `react` 19.2.8, `lucide-react` 1.26.0,
`react-markdown` 9.1.0); no fabricated APIs; no hallucinated Telegram WebApp fields — every
member `telegram.ts` declares (`initData`, `themeParams`, `BackButton`, `HapticFeedback`,
`disableVerticalSwipes`, `openLink`, `downloadFile`) exists in the SDK, and every optional
one is called through `?.`. **`npm audit`: 0 vulnerabilities**, prod and dev. No `TODO`,
`FIXME`, `XXX` or placeholder stub anywhere in `server/src` or `web/src`.

---

## 4. Test quality

The suite is better than AI test suites usually are: 20 of 28 mutations were caught, the
fixtures model the real `state.db` schema (seconds not milliseconds, `trigger` as JSON),
and `useAttachments.test.tsx` drives a real file input through React specifically because
an earlier bug hid behind endpoint-only testing. It is not tautological — very few tests
assert only that a mock was called.

But **8 of 28 mutations survived**, and the pattern is consistent: the guards with the
longest justifying comments were the least tested.

| Mutation | Survived? | Verdict |
| --- | --- | --- |
| `algorithms: ['HS256']` → `['HS256','none']` | ✅ survived | Alg pinning entirely unasserted. *(`none` turns out to be an **equivalent mutation** — `jsonwebtoken` rejects unsigned tokens whenever a secret is supplied — but widening to `HS512`/`HS384` **is** observable and was equally untested.)* → new tests |
| `{ readOnly: true }` → `{ readonly: true }` | ✅ survived | M-9. The documented test tested the library, not the module. → new test |
| Remove artifact containment check | ❌ caught (3) | Well covered |
| Widen `isValidSessionId` regex | ❌ caught (4) | Well covered |
| Remove filename sanitisation | ❌ caught | Well covered |
| `expiresIn` → 0 | ❌ caught (2) | Well covered |
| Remove first-divergence comparison | ❌ caught (2) | Well covered |
| Remove batching model guard | ✅ survived | Messages could batch across models — a turn runs at a model the user did not pick, and the queue counters look identical. → new test on spawned argv |
| Remove batching effort guard | ✅ survived | Same. → new test |
| Remove prose colour gate | ❌ caught (5) | Well covered |
| Bypass attachment allowlist | ❌ caught | Well covered |
| `every(w => w.kind === 'text')` → `true` | ✅ survived | **Equivalent mutation — the condition is unreachable.** L-1. → rewritten + tested |
| Wrong subagent↔child join | ❌ caught | Well covered |
| `epochMs` seconds→ms | ❌ caught (2) | Well covered |
| Break `runtimeConfig` merge | ❌ caught (3) | Well covered |
| Artifact fallback CT → `text/html` | ❌ caught | Well covered |
| Remove symlink skip in listing | ✅ survived | Redundant with `isFile()` (L-2), but the *behaviour* was unasserted. → new test |
| Bypass route upload cap | ✅ survived | Redundant with multipart's own throw (L-2), behaviour unasserted. → new test |
| `applyDelta` truncation → identity | ✅ survived | Dead on well-formed deltas (L-2); the defensive case was unasserted. → new test |
| `urlTransform` → identity | ✅ survived | **The XSS guard on untrusted transcript text was completely untested.** Removing it passed all 71 web tests. → new tests |
| Web: attachment cap / size cap / echo match | ❌ caught | Well covered |

After the fixes: **56 new assertions** across `server/test/audit.test.ts` (34) and
`web/test/audit.test.tsx` (14), plus rewrites. Every one was verified by re-running the
mutation it guards — the `V-*` pass confirms each now fails without its fix.

Two mutations remain equivalent by construction and are reported as such rather than
papered over with a test that would prove nothing: `alg: 'none'` (the library already
rejects it) and either rate-limit defence in isolation (each alone is sufficient; removing
**both** fails `A-1`, verified).

---

## 5. Left for the owner

1. **The session-id race with `bridge.py` (residual of H-5).** The mini app still learns a
   new session's id by watching the shared sessions directory. Serialisation and claim
   tracking remove the self-collision, but a session the Python bridge creates inside the
   poll window can still be mis-attributed. The real fix is for `aside exec` to print its
   session id; until then this is a narrow but real cross-process hazard, and it matters
   because both processes run continuously on the same machine.
2. ~~**`cloudflared` supply chain (M-6).** Pin a release tag and vendor its SHA-256, or make
   installing `cloudflared` the user's step.~~ **Done in round 6** — both, in fact: a pinned
   tag with vendored per-platform digests, verified before the binary is ever executed, and
   `MINIAPP_CLOUDFLARED_PATH` / `miniapp.cloudflared_path` for a binary you installed
   yourself. See the M-6 row above.
3. **Consolidate the three transcript readers (L-5)**, which needs the dead `/messages`
   route (M-5) and the discarded watcher parse (L-4) resolved first.
4. **The 14 unread web components.** Nothing in the audited slice suggests a problem, but
   they were sampled, not read.

---

## 6. Verification

```
npm run typecheck   # clean (server + web)
npm run build       # clean (vite + tsc)
MINIAPP_PORT=8792 MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0 npm test
#   server: 323 passed (323)
#   web:     83 passed (83)
```

The suite was **286 + 71** before this audit, with **1 failing** under that exact command.
It is now **323 + 83**, all passing, under that exact command.

Measured effect of the fixes on the owner's own largest session
(57 MB transcript):

| | Before | After |
| --- | --- | --- |
| `/thread` payload | 59.1 MB | **5.98 MB** |
| Diff cost per push (unchanged transcript) | 176 ms | **0 ms** |
| Diff cost per push (worst case, rebuilt) | 176 ms | **34 ms** |

No file outside `miniapp/` and `docs/` was modified. `bridge.py` and every other root file
were read only. The live server on port 8790, its tunnel and the Python bridge were never
touched; all probes ran against throwaway instances on ephemeral ports. Real session
transcripts and the daemon database were opened read-only, and no personal content was
copied into the repository.
