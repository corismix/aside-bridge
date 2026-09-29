# Aside update: change specification for aside-bridge

**Revised:** 2026-09-29 (third pass; supersedes both earlier revisions of this file)
**Scope:** what `aside-bridge` (Telegram bridge + Mini App/PWA) should change to match the current Aside agent experience, specified for a phone-first UI.
**Audience:** implementation. Every recommendation names the screen, control, state, or file it applies to.

## How to read this

| Tag | Meaning |
|---|---|
| **[src]** | Read out of the shipped extension JavaScript/CSS on disk (§1.2) |
| **[cli]** | Read out of the installed `aside` CLI's own help output, or established by a probe |
| **[live]** | Observed in the running Aside agent UI. Carried over from the first pass of this document; **not re-measured** this pass |
| **[shot]** | From the five supplied screenshots |
| **[discord]** | Aside Discord `#announcements` |
| **[code]** | Read out of `aside-bridge` source |
| **[gap]** | Could not be verified; listed in §10 |

Where sources disagree, shipping code wins over live measurement, which wins over Discord, which wins over older documentation.

---

## 1. Verification method and versions

- **Aside Browser (macOS):** `1.0.928.1` (`/Applications/Aside.app/Contents/Info.plist`). **[cli]**
- **Aside Browsing Agent extension:** `1.26.928.1922`, name `Aside Browsing Agent`, MV3. `side_panel.default_path: sidepanel.html`, `chrome_url_overrides.newtab: newtab.html`, `_execute_action` bound to `Alt+Shift+B` on both `default` and `mac`. **[src]**
- **Aside CLI used by the bridge:** `1.26.916.1741` (`/Users/casey/.aside/cli/Aside CLI.app/Contents/MacOS/aside --version`). **[cli]**
- **Discord `Updates / Sep 28`** names `Background service: v1.26.928.1922`, matching the installed extension. **[discord]**
- **Discord release post (Dora Lee, 2026-09-28)** covers `Aside Browser macOS v1.0.928.1 / Windows v1.0.928.2`. **[discord]**

The CLI trails the extension by twelve builds. Anything the CLI cannot express is a bridge gap, not necessarily a product gap.

### 1.1 Correction: the extension source **is** on disk

The previous revision of this document concluded the extension files were gone and that inspection was only possible through the live extension page. **That was wrong, and it is the single most consequential correction in the document.**

The full Vite/React build ships inside the application bundle: **[src]**

```
/Applications/Aside.app/Contents/Frameworks/
  Aside Framework.framework/Versions/1.0.928.1/
    Libraries/AsideAgentManager/          <- the extension, ~1240 asset chunks
```

Layout: **[src]**

| Path | What |
|---|---|
| `manifest.json` | MV3 manifest, permissions, side panel, commands |
| `sidepanel.html` | Side panel entry; preloads ~50 module chunks |
| `assets/session-composer-BbMCYIxX.js` | 328 KB — composer, model/effort picker, project picker, permission picker |
| `assets/permission-selector-CQjlToxh.js` | 17 KB — permission + final-confirm control, fully readable |
| `assets/session-permission-templates-B6KOByww.js` | 5 KB — canonical permission/confirmation definitions |
| `assets/permission-approval-Ddj-0iBE.js` | 490 KB — the approval card |
| `assets/thinking-levels-DLuCdpvc.js` | effort enum |
| `assets/model-select-nUpdDRo2.js` | model picker |
| `assets/sidepanel-DRE6GZKd.js` | side panel shell, composer modes |
| `assets/globals-d32IVJ-N.css` | design tokens, `@font-face`, `@theme` |
| `icons/`, `hero-illustration/`, `sounds/` | brand PNG/SVG, mascot, audio |

What this changes: **[src]**

1. Every visual and behavioural claim in this document is now re-verifiable in seconds, offline, without touching the running browser. The "open `chrome-extension://<id>/sidepanel.html` in a tab" procedure described in the previous revision is unnecessary.
2. The previous P0 item 5 ("record the fact that brand marks cannot be re-extracted from disk") is **deleted as factually wrong**. Replace it with the procedure below.
3. A future Aside update is diffable: compare `Libraries/AsideAgentManager/assets/` between app versions. Write this path into `docs/ASIDE-DESIGN.md`.

**Re-verification procedure (read-only, ~10 seconds):**

```bash
D="/Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/Current/Libraries/AsideAgentManager"
grep -rl "Ask Aside" "$D" --include="*.js" | head
head -5 "$D/manifest.json"
```

### 1.2 What was inspected this pass

Extension `manifest.json`; `sidepanel.html`; `assets/session-composer-BbMCYIxX.js`; `assets/permission-selector-CQjlToxh.js` in full; `assets/session-permission-templates-B6KOByww.js` in full; `assets/thinking-levels-DLuCdpvc.js` in full; targeted slices of `assets/permission-approval-Ddj-0iBE.js`, `assets/types-CIHkh8Za.js`, `assets/use-agent-settings-IADixfBg.js`, `assets/globals-d32IVJ-N.css`; the icon-chunk population; CLI `--help` output plus two `--effort` probes; `aside-bridge` source and docs; Aside Discord `#announcements` 2026-09-19 → 2026-09-29; five screenshots at full resolution.

---

## 2. The current Aside agent experience

### 2.1 Architecture **[src]**

The extension is a first-party, browser-managed MV3 extension, not a thin CLI client. It talks to the local Aside Daemon over tRPC on `127.0.0.1:21420` with an `/auth/daemon/verify` handshake **[live, prior pass]**. Native bridge surfaces are host messages, e.g. `Aside.pickDirectory` with a `params.prompt` string and a result of `{status: "cancelled" | "unavailable", path}`.

`aside-bridge` reads a different set of sources: the `aside` CLI (`exec` / `session resume` / `repl`), `~/.aside/u/0/sessions/*/messages.jsonl`, `models.json`, `cache/models-catalog.json`, `settings.json`, and a read-only SQLite handle on `state.db`. **[code]**

This is the largest structural delta. §9.1 treats it as an option, not a recommendation.

### 2.2 Extension permissions worth knowing **[src]**

`manifest.json` requests `sidePanel, contextMenus, storage, activeTab, tabCapture, offscreen, debugger, downloads, favicon, history, bookmarks, topSites, browsingData, privacy, management, nativeMessaging, cookies, tabs, scripting, userScripts, webNavigation, sessions, tabGroups, alarms, notifications`, plus nine private `at.studio.Aside.ext.private.*` APIs. Host permissions are `<all_urls>` and `https://api.anthropic.com/*`.

There are two content scripts: `content/content.js` on all URLs at `document_idle`, and `content/google-docs-selection-bridge.js` on Google Docs in the `MAIN` world.

**Consequence for the bridge:** the sidebar can see live tab state, history, bookmarks and page content. The bridge, attached to a phone, can see none of it. Every feature in this document that depends on page or tab context is a desktop-only capability by construction, not by omission.

### 2.3 Composer anatomy **[src]**

The composer is a named container: `<div className="@container/composer mx-auto w-full px-3 pb-2" data-agent-session-ui="chat">`. Inside it:

**Two tiers, always.** `np` renders a rounded container holding (a) a ProseMirror rich-text editor with `editorClassName="composer-editor px-2 py-3 leading-5! in-data-[multiline=true]:px-3.5"`, (b) a badge row above the editor, (c) a left floating action slot and a right floating action slot. The control row sits **outside and below** this container, in the sibling wrapper `Qt`, which adds `px-4 pt-1 pb-2`.

**Surface states.** `Qt` takes a `mode` and renders `mode === "default"` inline, `mode === "approval"` inside a raised card (`bg-surface-primary ring-border-surface overflow-hidden rounded-2xl shadow-md ring-[0.5px]`) with a footer status line, and any other mode hidden with `aria-hidden` + `inert`. The composer's `mode` comes from `session.suspension` via `Is(d.suspension)`. `action-confirmation` and `ask-user-question` also appear as composer modes in `assets/sidepanel-DRE6GZKd.js`.

**Draft preservation.** When the composer is replaced by a mode other than `default`, a `role="status"` line reads *"Your message draft is saved and will return when this closes."* **[src]**

**Drag and drop.** Dropping files or folders onto the composer shows a `text-brand-content pointer-events-none absolute inset-0 z-10` overlay, and routes folders to the session's working directories rather than uploading them. **[src]**

**Mentions.** `RichInput` (`assets/create-editor-BcS4ZY4U.js`) supports `@` mentions of **skills**, **commands** and **open tabs**. The suggestion surface is `bg-glass border-glass rounded-xl p-1.5 shadow-lg max-h-60`, rows `min-h-8` (sm: `min-h-7`), keyboard-navigable, clamped to 280–360 px wide. Rows render an icon source in preference order: a custom `icon` image URL, else a per-type icon (`magic-book` for skill, `globe` for tab, the command's own icon).

**Placeholder.** The editor default is **`Reply, @ for context`**, overridable per surface: **`Ask AI a task, @ for context`** (splash / tasks / project), **`Ask Aside a task, @ for context`** (new-tab editor), **`Ask Aside`** (mini popup), **`Ask Aside on tab switch`** (two surfaces). **[src]**

### 2.4 Composer controls, in shipping order **[src]**

| Slot | Control | Evidence |
|---|---|---|
| Pill, left | `+` — `aria-label="Composer options"`, `data-testid="attachments-button"`, `size="icon-sm"`, `variant="secondary"`, `shape="pill"` | `Dl` in `session-composer` |
| Pill, right | Dictate — tooltip, mic glyph; states: idle, *"Recording is not supported in this browser."*, *"Microphone permission denied."*, *"Transcribing"*, *"No audio captured. Try again."*, *"Cancel dictation"*, *"Convert recording to text"* | string table |
| Pill, right | **Stop** — `aria-label="Stop"`, `data-testid="stop-button"`, `size="icon-sm"`, `shape="pill"`, icon `hi` in `text-primary-foreground` | `El` |
| Pill, right | **Send** — `aria-label={responseSubmitLabel ?? "Send"}`, `data-testid="send-button"`, kbd hint `⏎` | `El` |
| Row, 1st | **Permission / Confirmation** — `data-slot="agent-session-permission-trigger"`, `aria-label` = current label, icon `size-4` `data-icon="inline-start"`, chevron `size-3.5 opacity-50` `data-icon="inline-end"`, text `text-xs text-muted-foreground`, wrapper `inline-flex items-center gap-1 text-xs max-sm:gap-0.5` | `wt` in `permission-selector` |
| Row, 2nd | **Project** — same slot shape, label `data-slot="agent-session-label"` | `fo` / `ys` in `session-composer` |
| Row, right | **Model** — provider glyph `size-4` + `shortName` | `H0`, `V0` |
| Row, right | **Effort** — `data-model-select-shortcut="thinking"`, `size="xs"`, `shape="pill"`, `aria-expanded` on the pill | effort block in `session-composer` |

The `+` menu contents, in order **[src]**: whatever the composer passes as `children` (the permission control), conditionally an **Incognito mode** checkbox (`disabled` while streaming, and `disabled` outright when no mode handler is supplied), a separator, then **`Upload photos & file`** (hidden `<input type="file" multiple accept=...>`) and **`Attach folder`** (native `Aside.pickDirectory`, prompt *"Attach a folder to this chat"*; failure toast *"Folder picker is not available on this device."*).

**Stop and Send are two controls, not one that morphs.** `El` renders the Stop row only when `isStreaming && !canSend`. So while the agent is streaming with nothing typed, the button is **Stop**; while streaming *with* something typed, it is **Send**. The send button then carries `responseSubmitLabel`, whose busy-state tooltip reads *"Send at the next opportunity instead of waiting in the queue"* and whose accessible label becomes **`Send now`**. **[src]**

### 2.5 Narrow-width behaviour **[src]**

This is the mechanism behind the icon-only screenshots, and it is a deliberate collapse under space pressure, not a design endorsement:

- The composer is a CSS **container query** context (`@container/composer`). At `@max-[520px]/composer` it tightens outer padding (`px-4` → `px-1.5`), tightens the editor padding (`py-3` → `py-2.5`, and `px-2` → `px-1.5` when single-line), and increases the bottom reserve to `pb-9`.
- Control labels hide at two independent breakpoints: **`max-sm:hidden`** (viewport `sm` = 384 px) and **`@max-sm/composer:hidden`** (composer container `sm`). Both the project label (`ys`) and the permission label (`wt`) use them. The permission pill also tightens its own gap, `gap-1` → `max-sm:gap-0.5`.
- The permission control accepts **`alwaysShowLabel`**, and the composer passes `alwaysShowLabel: !0`. So in the composer the label survives; the mini-popup variant is the one that collapses.

**No touch-target compensation ships.** The only `max-sm:size-*` rules in the composer chunk are on an empty-state illustration (`size-16` → `size-12`). Composer controls stay `icon-sm` / pill and roughly 24–28 px tall at every width. **[src]**

### 2.6 Permission and confirmation **[src]** — `session-permission-templates-B6KOByww.js`, read in full

**Permission mode.** Exactly three values. Default export `h = "guard"`.

| Key | Label | Shipped description | Icon |
|---|---|---|---|
| `read-only` | **Read only** | "Can only work in this task’s folder. Won’t access other folders." | inline SVG, two stacked panels |
| `guard` | **Guard** | "Can work in Documents, Downloads, and this task’s folder. Asks before accessing other folders." | `shield-check-3` chunk |
| `full-access` | **Full access** | "Can read and write anywhere on this computer." | inline SVG, four-way arrow |

**Final confirm.** A boolean, collapsed to a two-item radio: `{value:true, label:"Ask first", tooltip:"Ask before actions like send, pay, delete, or submit.", icon:hand}` and `{value:false, label:"Skip confirmation", tooltip:"Proceed without asking for confirmation.", icon:skip-forward}`. Persisted client-side in `localStorage` under **`aside.last-final-confirm.v1`**.

**The trigger.** `wt` renders one button containing the current icon, the current label, and a chevron. Colour rules:

```js
a && !c && "text-orange-500"                                   // final-confirm variant, switch OFF
!a && r === "full-access" && "text-orange-500 dark:text-orange-400"
```

So **orange is a caution token, not a danger token**, applied to two different conditions. The accessible name is the current state, not the action: `aria-label: o.label`. Tooltip text is `"Confirmation"` in the final-confirm variant and `"Set permission mode"` otherwise.

**The menu** (`w-72`, `size="sm"`), in order: a **`Permission`** radio group where each option carries its icon, its label (`pr-4`) and its description in a right-side tooltip; a separator; a **`Final confirm`** switch row with the book-and-wand icon and the `Ask first` tooltip; then a `className="hidden"` **`Developer`** group containing *Disable memory extraction* ("Skip automatic memory writes after this task. Memory recall stays available.") and a hard-checked *Password access* row. A final **Global setting** row deep-links to `/u/{accountId}/settings/agents?focusField=Access%20permission`.

The mini popup renders the same control as a **submenu**: a row with the `shield-check-3` icon, the word "Permission", the current mode right-aligned, opening a `w-72` popup that contains the project list and the permission controls together.

**Session shape.** `permissionMode` defaults to `"guard"` wherever the daemon omits it. `runtimeConfig` is `{ memoryExtractionDisabled, proactiveMode, finalConfirm, workingDirs }`. `incognito` is a separate session boolean derived from the mode selector. **[src]**

### 2.7 The approval card **[src]** — `assets/permission-approval-Ddj-0iBE.js`

This is the reference for anything `aside-bridge` renders when it must ask the user to authorise an action. Structure:

1. Container `@container relative flex flex-col`, `role="group"`.
2. Header block `p-2.5`, `h3` class `text-foreground text-base font-medium`, text **"Allow Aside to do this action?"**, followed by a rendered preview of the pending tool call (`scope` + `toolCallId`).
3. Option rows, each full-width `ghost`, each prefixed by a **numbered index** `${i+1}.` in `w-4.5 tabular-nums text-muted-foreground`, highlighted when selected with `bg-accent!`. Options have `choice: "allow" | "deny" | "custom"`, a `label`, and an optional `shortcut` rendered as a kbd hint. The **custom** option renders an inline auto-sizing textarea whose placeholder *is* that option's label — "tell Aside what to do instead" as a first-class choice, alongside the composer's "Or tell Aside what to do instead".
4. Footer `label` with a checkbox: **"Do not ask again for this action"**, pre-checked.

Keyboard contract: `Cmd/Ctrl+Enter` confirms the focused option; `Enter` allows (non-custom rows) or saves (custom row); `Escape` **denies**; `ArrowUp/ArrowDown` move selection. A `window` keydown listener is installed while the card is open.

Rejection with a reason is a first-class path: the mutation takes an optional `error` string, so "deny and explain" is a supported outcome, not a side channel.

### 2.8 Models and effort **[src]**

**Effort enum** (`thinking-levels-DLuCdpvc.js`, read in full): `{ off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }`, exported as `Object.keys(...)`.

**Effort labels** (`use-agent-settings-IADixfBg.js`): `Off, Minimal, Low, Medium, High, Extra High, Max`. Note **`xhigh` renders as "Extra High"**, and screenshot 5's `Max` is therefore a real shipped label, not a custom one.

**Per-model capabilities**: `availableThinkingLevels: string[]`, `supportsFastMode: boolean`, `supportsVision: boolean`, `shortName`. The effort menu renders only the levels a model declares.

**Model presets.** `types-CIHkh8Za.js` defines four tiers — `fast`, `standard`, `deep`, `visual` — each an ordered list of `{provider, modelId, thinkingLevel}`. This is Aside's actual opinionated ladder, and it is more useful to the bridge than a flat model list because it answers "which model should I offer by default" without guessing.

**The model menu.** Autofocused `Search models` field with a `size-4` leading icon; arrow keys move between `menuitemradio` rows; models grouped under provider headers (`flex items-center gap-1.5 select-none`); empty state *"No matching models"*; computed width 200 px. Each row renders **both** the provider glyph (`size-4 text-muted-foreground`) **and** `shortName` — provider identity is not trigger-only. Search normalisation rewrites `gpt-` to `gpt ` so `gpt 5` matches.

**Fast mode** is rendered as a mutation of the provider glyph, not a label:

```js
style={ fastMode ? { maskImage: "radial-gradient(circle 5px at 12px 12px, transparent 4px, black 5px)" } : undefined }
// plus
<Li aria-label="Fast mode" className="absolute top-2 left-2 size-2 text-sky-500" />
```

A **punched hole in the corner of the glyph** plus a 2 px sky-500 dot. The menu row is a switch labelled **"Fast mode"** with the tooltip *"Significantly faster" <br> "consumes more usage"*, and it is **`disabled` when the account tier is `free`**.

**Keyboard**: the effort menu is `Meta+Shift+.`.

**Ultrabrowse** disabled-state copy, verbatim: **"Upgrade to Pro and unlock Ultrabrowse for deep research and complex tasks."** **[src]**

### 2.9 Projects **[src]**

`fo` is the picker. Behaviour worth copying:

- List = `projects.list` filtered on `!archivedAt`.
- **Re-selecting the active project deselects it** (`onValueChange(m => m === value ? null : m)`). Tapping the current project is a real "no project" gesture.
- Menu `w-56`, size `sm`. Header row "Projects", then rows: project icon (`size-4`, tinted by the project's `color` field) + truncated name. Selecting the active row calls the deselect handler instead of setting.
- Separator, then two actions: **"Use an existing folder"** (native `Aside.pickDirectory`, prompt *"Choose the default workspace for this Project"*; on `unavailable` it toasts *"Folder picker is not available on this device."*) and **"Start from scratch"** (opens a create-project dialog).
- Creating from a folder names the project after the last path segment and de-duplicates ids with `-2`, `-3`.
- The trigger's label reads the project **name**, or the literal `"Project"` when unset, and hides via `truncate max-sm:hidden`.
- Every project row renders `<Icon className="size-4" color={project.color} icon={project.icon} />`. Projects carry a **colour and an icon**, not a colour dot. **[src]**

The picker accepts a `submenu` variant that swaps the trigger for a menu row reading "Projects" + the current project name right-aligned. `Dn` wraps the permission control so a **draft** (pre-session) permission mode and confirmation can be set before the session exists.

Moving an existing session to a project is a **500 ms press-and-hold** with a dedicated `touch` branch and a 10 px movement threshold. **[src]**

### 2.10 Other session controls present in shipping code **[src]**

From the composer's string table and component tree: **Side chat** ("Ask in side chat", "New side chat", "Toggle side panel", "Expand side panel", "Restore side panel"), **Subagents** ("No active subagents", "Back to subagents", "Send follow-up with subagent."), **Routines**, **Incognito mode**, **Branching** ("Branched from", "Failed to branch the session."), **Queue** ("Queued messages", "Send now", "Cancel queue edit", "Queue paused because you interrupted"), **Compaction** ("Context automatically compacting", "Context compacted", "Compaction failed"), **Memory** ("Memory signal", "Memory updated", "Searched memory"), **queued-message editing** ("Edit message", "Send message?", "Failed to edit the message."), and per-message system-notification toasts.

The `mode` selector (`default` / `incognito`) lives **inside the `+` menu**, not in the control row. **[src]**

### 2.11 CLI surface, probed this pass **[cli]**

```
$ aside exec --help
  -s, --speed <speed>        Model speed (choices: "default", "fast")
  --effort <effort>          Thinking effort (choices: "off", "minimal", "low",
                             "medium", "high", "xhigh", "max", "ultrabrowse")
  --permission <mode>        Session permission: ask/guard (ask before other
                             folders) or full-access
  --account <id>             Account id, e.g. u0 or u1
  --host <host>              'local', a remote host id, or its device name
```

The `--permission` help text states: **"`--permission ask` and `--permission guard` are the same (Guard). Omit for Guard."** The CLI therefore exposes **two** effective modes, not three: `read-only` has no CLI equivalent. **[cli]**

`aside session` subcommands, all confirmed: `list`, `resume`, **`stop <id>`**, **`steer <id> <prompt>`**, **`queue <id> <prompt>`**, `archive`, `delete`. Help text: *"steer interrupts the current step. queue waits and runs next."* **[cli]**

`aside settings` exposes only `save-sessions <value>` and `set-default-profile <id>`. **[cli]**

### 2.12 Discord, supporting only **[discord]**

Aside server, guild `1518417473043693608`, `#announcements` (`1518420346057785444`), read 2026-09-29.

- **Updates / Sep 24** (`hiddenest`, posted 2026-09-26, `v1.26.926.1637`): "Polished chat composer"; "You can easily setup Ask first(Aside will ask you before critical actions like delete, wire transfer and such) or Skip confirmation."; "You can pick and edit message in queued messages"; "Click PlusIcon button (permission and project are moved to here)"; "You can set default permission on Settings > Agents"; "Compaction starts at 85% of the context window".
- **Updates / Sep 28** (`hiddenest`, `v1.26.928.1922`): 60–93% CPU/memory improvement across CDP, tab preview, memory embedding, EventBus and WebSocket; "Kept composer spacing stable while typing in chat"; "Preserved scroll position while reading long conversations"; "Preserved images and screenshots so the agent does not lose them midway".
- **Aside Browser macOS v1.0.928.1** (`Dora Lee`, 2026-09-28): rename tabs; "Confirm before clearing"; on macOS 27+ popups including **permission prompts** get a glass background.
- **Updates / Sep 21**: subagents can each use a different model; Context Awareness on Windows; compaction reliability.
- **Updates / Sep 23**: "Aside has started validating and fixing reported issues by itself."
- **Jun Kim, 2026-09-23**: "we're cooking Aside v2", hiring a **designer**, GTM, and **iOS**.

Two consequences:

1. **The "PlusIcon" claim is half right.** Shipping code shows permission rendered in *both* the `+` menu (as passed children) *and* the control row, while **project is only in the control row and its own menu** — it is not in the `+` menu. **[src]** Trust the code.
2. **Aside v2 is in progress.** Parity work should be scoped as "parity with `1.0.928.1` / `1.26.928.1922`", and design-token work should be treated as the durable contract rather than component-for-component mirroring. **[discord]**

---

## 3. Screenshot analysis

Five 2× captures of the side panel. **Reconciling the attribution:** every string in the shots is present in `1.26.928.1922`. `Reply, @ for context` is the editor default (§2.3); `New chat` appears in `sidebar-ClpdvCLR.js` and `-components-D-jhr8cr.js`; `gemini-3.8-flash` is present in the shipped asset text; and the two-tier composer, the left permission / right model+effort alignment, and the icon-plus-chevron pill shapes match `np` + `wt` + `H0` exactly. These are Aside. **[src + shot]**

One label could not be pinned: **`Space Bunny Free`** (shot 5). `Space Bunny` is the model-tier codename this Aside installation reports for its own agent session, but it appears in neither the extension assets nor `~/.aside/u/0/models.json`. Treat it as a per-install label, not a product string. **[gap]**

### Shot-by-shot

**`image-9b496963-…png` — New chat, empty.**
Header: `New chat` + chevron left; pop-out and close right. Body: a large low-opacity Aside mascot mark centred as the empty-state watermark. Composer pill: `+` left, mic right, placeholder `Reply, @ for context`. Control row: a hand glyph + chevron, a container/box glyph + chevron, then `G` provider glyph + `Gemini 3.8 Flash` + `High` + chevron.

**`image.png` — same state, different second control.**
First control unchanged (hand = *Ask first*). Second control is a **tray/box glyph**. Model and thinking unchanged.

**`image-dc5190a5-…png` — second control is a key glyph** (blue). Everything else identical. Confirms the second slot is **variable identity**, not a fixed icon.

**`image-d0f7387a-…png` — first control orange and changed to a skip/play-forward glyph; second control is a grey "no entry" glyph.**
This is the Full access + Skip confirmation combination: `wt` with the final-confirm variant and `c === false` applies `text-orange-500 dark:text-orange-400`, and the `false` icon is the skip-forward SVG. **[src]** This is the clearest demonstration in the set that **the orange is a caution token on the permission/confirmation control, not a project tint.**

**`Screenshot_2026_09-29_13-56-07.png` — running session with a draft and page context.**
A page-context pill sits at the top of the composer: favicon + `(56) Discord | #ann…` over `discord.com`. Draft text below. Bottom row inside the pill: `+` left, mic and a **white circular send (up arrow)** right. Control row below: the four-way-arrow *Full access* glyph, a green project glyph, and a provider glyph + `Space Bunny Free` + `Max`. `Max` is a shipped effort label (§2.8). **[src + shot]**

### What the shots establish

- Two-tier composer in every state; model and effort right-aligned; permission and project left-aligned.
- Labels collapse to icon-only at narrow widths. **This is responsive pressure on a ~420 px panel, not a recommendation.** See §8.9.
- The page-context chip (favicon + title + host + Remove) is a real, first-class composer element.

### What the shots do not establish

- Which project each glyph belongs to, or whether the tints are the project `color` field or per-provider brand colours. The source says project identity is `color` + `icon` **[src]**, so project tints are almost certainly the `color` field, but the specific projects are unidentified. **[gap]**
- The `G` and book glyphs are provider marks, rendered by the provider-icon component, not project glyphs.

---

## 4. Visual system

### 4.1 Icons **[src]**

There are **two** icon systems, and conflating them is the main visual risk.

**System A — the toolbar/composer set.** 81 chunks in `assets/` are self-contained icon modules under ~3 KB with an identical signature:

```js
({ size = 24, ariaHidden = true, ...props }) =>
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
       width={size} height={size} aria-hidden={ariaHidden} focusable="false" {...props}>
    <path d="…" fill="currentColor" />
  </svg>
```

Verified characteristics, all quoted from the shipped chunks:

- **Filled**, single `<path>`, `fill="currentColor"`. No strokes anywhere in this set.
- **24 × 24 authoring grid**, rendered at an explicit `size` prop that defaults to 24.
- **Weight is encoded in the filename**, not in a prop: `chevron-down-medium`, `chevron-down-small`, `checkmark-2-medium`, `cross-medium`.
- **`aria-hidden` defaults to `true`; `focusable="false"`** is always set. Accessible names live on the interactive ancestor.
- Colour is exclusively `currentColor`. No baked-in fills.

Full population includes `shield-check-3`, `hand-5-finger`, `plus-medium`, `chevron-down-medium`, `chevron-right-medium`, `chevron-top-medium`, `checkmark-2-medium`, `cross-medium`, `key-2`, `folder-1`, `folder-open`, `paperclip-1`, `globe`, `magnifying-glass`, `magnifying-glass-2`, `sparkle`, `settings-gear-2`, `settings-slider-hor`, `arrow-corner-down-left`, `arrow-box-right`, `arrow-up-right`, `arrow-rotate-clockwise`, `arrow-undo-up`, `trash-can`, `dot-grid-1-x-3-horizontal-tight`, `square-arrow-top-right-2`, `pencil`, `pencil-2`, `circle-check`, `circle-x`, `circle-info`, `circle-questionmark`, `clock`, `lock`, `macbook`, `people-circle`, `projects`, `puzzle`, `zap`, `volume-full`, `window-cursor`, `bubble-3`, `magic-book`, `play`, `list-bullets`, `copy-button`, `devices`, `browser-tabs`, `dossier`, `console`, `markdown`, `markdown-preview`, `gmail`, `slack`, `chips-simple`, `apple-icon`, `pricing-table-shared`, `3-d-box-top`, `official-brand-slime`.

**Upstream library attribution is unresolved.** **[gap]** The set is internally consistent, but the naming and geometry do not match one well-known library exactly — `hand-5-finger`, `dot-grid-1-x-3-horizontal-tight` and `chips-simple` map cleanly onto none of Phosphor, Lucide, Tabler or Radix canonical names. The previous revision of this document asserted **Phosphor**; that assertion is withdrawn. **What is verified is the contract above, not the brand.** `official-brand-slime` is presumably Aside's mascot; `gmail` and `slack` are the site-skill marks.

**System B — Radix stroke primitives.** Used for form controls, not toolbar. Example, `checkbox-B_xQPtC0.js`: `viewBox="0 0 16 16"`, `strokeWidth="2.25"`, `strokeLinecap="round"`, `strokeLinejoin="round"`, with a `pathLength` draw animation on check (`duration: checked ? .22 : .12`, `ease: [.22,1,.36,1]`). This is `@radix-ui/react-icons`.

**Recommendation (§8.5): adopt System A's contract, keep the bridge's own icon library.** The contract is: filled or stroked consistently, 24 px authoring grid scaled optically, `currentColor` only, `aria-hidden` on decorative glyphs, accessible name on the control, one optical weight across the set.

### 4.2 Colour tokens **[src]** — `assets/globals-d32IVJ-N.css`

Near-achromatic neutrals, with exactly three chromatic families: `--brand` (sky), `--destructive` (red), `--success` (emerald), plus the eight-stop `--ultrabrowse-*` rainbow.

| Token | Dark | Light |
|---|---|---|
| `--background` | `var(--color-neutral-900)` | `var(--color-white)` |
| `--popover` | `var(--color-neutral-800)` | `var(--background)` |
| `--muted-foreground` | `oklch(98.5% 0 0/.55)` | `oklch(14.5% 0 0/.55)` |
| `--border-surface` | `oklch(98.5% 0 0/.15)` | `oklch(14.5% 0 0/.1)` |
| `--surface-primary` | `oklch(98.5% 0 0/.08)` | `oklch(100% 0 0)` |
| `--brand` / `--color-brand` | `var(--color-sky-400)` | `var(--color-sky-500)` |
| `--success` | `var(--color-emerald-400)` | `var(--color-emerald-500)` |
| `--destructive` | `var(--color-red-400)` | `var(--color-red-600)` |
| `--ring` | `oklch(98.5% 0 0/.08)` | `oklch(14.5% 0 0/.08)` |

The composer uses `ring-border-surface` (not `border`) for its hairline: `ring-border-surface overflow-hidden rounded-2xl shadow-md ring-[0.5px]`.

**The caution colour is a stock Tailwind token, not a custom one.** `text-orange-500 dark:text-orange-400` in `wt` resolves to the stock palette; no `--color-orange-*` override exists in the theme. Same for the fast-mode `text-sky-500` dot. So `--permission: orange-500 / orange-400` in the bridge is correct as-is. **[src]**

### 4.3 Geometry, type, motion **[src]**

- `--squircle-factor: 1.4`; `--radius: .625rem`; `--radius-xs: .125rem`; `--radius-md/lg/xl/2xl/3xl = calc(.375/.5/.75/1/1.5rem × 1.4)` = **8.4 / 11.2 / 16.8 / 22.4 / 33.6 px**; `--hairline: .5px`.
- Type scale `xs .75` → `4xl 2.25 rem`; weights 400–700.
- **Fonts:** `"Geist Variable", "Geist", sans-serif`; mono `"Berkeley Mono", "Geist Mono Variable", "Geist Mono", "JetBrains Mono", monospace`; and a third family **`"Aside Display"`**, declared `@font-face` at weight 100–900 from `assets/AsideDisplay-Variable-LuohODSt.woff2`, used as `font-family: Aside Display, Geist, sans-serif` for display type. **[src]** That variable font is a shippable, extractable asset.
- The framework bundles all 16 Geist static TTFs in `Resources/` (Thin → ExtraBold, plus italics).
- Popover/menu surface: `bg-glass border-glass rounded-xl p-1.5 shadow-lg`; sm variant `rounded-lg`.
- Menu item minimum height `min-h-8` (sm: `in-data-[size=sm]:min-h-7`), radius `rounded-lg` (sm: `rounded-md`), padding `px-2.5 py-1` (sm: `px-1.5 py-1.5`).

### 4.4 How `aside-bridge` compares **[code]**

**Matching — leave alone.** `miniapp/web/src/theme/tokens.css` already reproduces `--squircle-factor: 1.4`, the identical radius ladder, `--hairline: .5px`, the Geist / Berkeley Mono stacks, the same type scale, the same easing and 0.15 s duration, and dark values for `--background`, `--popover`, `--primary`, `--muted-foreground`, `--surface-*`, `--border*`, `--brand`, `--success`, `--destructive`, `--ring`. `--permission` is `var(--color-orange-500)` light / `var(--color-orange-400)` dark, matching the desktop trigger exactly. **There is no token work left to do.** That conclusion from the previous revision is confirmed against source.

**Divergent by choice.** The bridge uses `lucide-react` (stroke) plus hand-authored inline SVGs in `Icons.tsx`, `Brand.tsx`, `AsideLogo.tsx`, `Creature.tsx`; Aside uses a filled 24 px set plus Radix strokes. Two sets will never render identically side by side, and forcing filled glyphs into a stroke set would make the bridge look worse, not more like Aside. §8.5.

**Newly available.** `AsideDisplay-Variable-LuohODSt.woff2` and `icons/brand-embossed-{light,dark}.svg` are on disk and can be re-extracted at any time (§1.1).

---

## 5. `aside-bridge` today

### 5.1 Composer — `miniapp/web/src/components/Composer.tsx` **[code]**

- Placeholders `'Chat with Aside…'` (home) / `'Reply to Aside…'` (reply), `Composer.tsx:310-312`. The current strings use a **Unicode ellipsis** `…`; the replacement must use three ASCII dots.
- The header comment at `Composer.tsx:13-18` explains why `@ for context` was dropped: live tab inventory lives in the extension, not the daemon. **That reasoning is now confirmed correct by source** (§2.2) and should stand.
- Controls: attach (icon-only, `aria-label="Attach files"`, 30×30), stop (icon-only, 30×30, streaming only), send (icon-only, 34×34, `ArrowUp`), project pill (home only, 28 px), permission pill (`aria-label="Permission"`, 28 px), context ring, model pill, effort pill. All pills labelled.
- `canSend` (`:254-258`) requires text or a ready attachment, no upload in flight, not `disabled`, not `blocked`.
- No mic, no steer control, no busy-state send relabel.
- The two-tier layout is already correct; do not restructure it.

### 5.2 Pickers **[code]**

- `ModelSheet.tsx`: provider grouping, current provider hoisted, search with `gpt 5` → `gpt-` normalisation, `Check` selection, `ProviderMark` leading. No vision badge, no fast treatment, no capability gating — although `DesktopModel` in `desktop.ts:42` already parses `vision: boolean` and forwards it.
- `ProjectSheet.tsx`: 15 named colours, Lucide glyph mapping with `Folder` fallback, provider brands special-cased, workspace path as a subtitle on duplicate names. **No create-project, and no deselect gesture.** Project context is **prompt-seeded** — `server/src/projects.ts:7-14` records that `aside.sessions.update` silently ignores `projectId` and `cwd`.
- `ReasoningSheet` (`ModelSheet.tsx:109-140`) renders `status.effortMenu`; `ultrabrowse` is hard-disabled with the subtitle "Availability must be checked in Aside."
- `AdaptivePickerSurface.tsx`: bottom sheet under 640 px, anchored popover at/above. Correct.
- `Pickers.tsx:55-112`: three permission modes with descriptions and a `Confirm before acting` `role="switch"`.

### 5.3 Effort — `miniapp/server/src/config.ts` **[code]**

`EFFORT_LABELS` (`:24-33`) includes `max: 'Max'`. `EFFORT_LEVELS` (`:48-56`) **excludes** `max`. The comment block at `:28-36` justifies this by quoting a CLI error listing the allowed choices *without* `max`.

**That quoted error no longer matches the installed CLI.** See §2.11 and §10.1.

`EFFORT_MENU` (`:65-71`) = `low, medium, high, xhigh, ultrabrowse`.

### 5.4 CLI invocation **[code]**

Neither surface passes `--permission`, `--speed`, `--account`, or `--host`. Both set permission after the fact through `aside repl` → `aside.sessions.update`, because `--permission` only offers `ask|guard|full-access` and has no `read-only`. `exec.ts:316-327` / `:581-594` spawn `['exec', '-m', model, '--effort', effort, '--', text]`; `bridge.py:675-703` spawns `[ASIDE_CLI, '-m', …, '--effort', …, ('session','resume',id) | 'exec', '--', prompt]`.

`--speed default|fast` and `aside session stop|steer|queue` are available and unused. **[cli]**

### 5.5 Telegram — `bridge.py` **[code]**

Commands: `/start` (`:1205`), `/status` (`:1207`), `/model` (`:1219`), `/usage` (`:1227`), `/effort` (`:1231`), `/new` (`:1241`), `/project` (`:1245`), `/sessions` (`:1247`). Callback prefixes `eff:` (`:1142-1194`), `appr:`, `q:`. Queue `TASKS` (`:1192`); `worker_loop` (`:2320-2362`) batches adjacent messages with `\n\n` (`:2334-2344`). **No `/stop` and no `/steer`**; `_reap_stale_exec` (`:2364-2401`) only `pgrep`s and `SIGTERM`s at bridge startup. `MODEL_ALIASES` (`:750-754`), `MODEL_IDS` (`:765-777`). `catalog.ts:67-129` `BUILTIN` seeds `aside, claude-code, openai-codex, opencode, xai-grok-oauth`.

### 5.6 Doc defects to fix alongside the code **[code]**

- `docs/MINIAPP.md:20-24` documents `aside --model <m> --effort <e> exec "<text>"`. The code passes `exec` first, uses `-m`, and places `--` before the text.
- `docs/ASIDE-DESIGN.md` is pinned to `1.0.922.1` / `1.26.923.310`; current is `1.0.928.1` / `1.26.928.1922`. Its tokens still hold (§4.4).
- It should record the on-disk extension path (§1.1) instead of claiming extraction is impossible.

---

## 6. Deltas: current Aside vs `aside-bridge`

| # | Aside (current) | `aside-bridge` today | Type |
|---|---|---|---|
| 1 | Extension source ships on disk and is diffable | `ASIDE-DESIGN.md` says it cannot be re-extracted | **Doc fact error** |
| 2 | Composer placeholder `Reply, @ for context` / `Ask AI a task, @ for context` / `Ask Aside` | `Chat with Aside…` / `Reply to Aside…` (Unicode ellipsis) | Copy |
| 3 | `--effort` accepts `max` | `max` excluded on a stale CLI error quote | **Stale block, now settled** |
| 4 | `aside session stop` exists | No `/stop`; relies on `pgrep` + `SIGTERM` at startup | Missing, better fix available |
| 5 | `aside session queue` / `steer` exist | Local FIFO only | Partial |
| 6 | Send relabels to `Send now` with a queue tooltip while streaming | Send stays Send | Missing state |
| 7 | Stop and Send are separate controls, chosen by `isStreaming && !canSend` | Stop only while streaming, send always visible | Minor divergence |
| 8 | Permission + final-confirm are one composer-row pill with Aside's copy and orange caution semantics | Switch inside the permission sheet, `aria-label="Permission"` | Placement + copy |
| 9 | Three modes, default `guard`, exact shipped descriptions | Three modes, different descriptions, default unstated | Copy |
| 10 | Project trigger present in both composers; re-select deselects; row shows colour + icon; create-project action | Home only; always labelled; no deselect; no create | Missing |
| 11 | `+` opens a menu (attach file / attach folder / incognito) | `+` opens a raw file input | Interaction |
| 12 | Approval card: numbered options, Allow / Deny / custom-with-textarea, "Do not ask again for this action", deny-with-reason | Approve/deny card, no numbering, no custom text | Missing affordances |
| 13 | Draft preserved across mode switches with a status line | No draft preservation across card states | Missing |
| 14 | Queued messages visible and editable before they run | Queued messages invisible until they run | Missing feature |
| 15 | Effort labels match (`xhigh` → "Extra High", `max` → "Max") | Matches | OK |
| 16 | Model rows show provider glyph + short name, grouped per provider, "No matching models" | Groups + check + search, no per-row glyph | Minor |
| 17 | `supportsVision`, `supportsFastMode`, `availableThinkingLevels` gate options | `vision` parsed at `desktop.ts:42`, never used | Dead field |
| 18 | Fast mode: punched-out provider glyph + sky-500 dot, disabled on free tier | Not surfaced, not passed | Missing |
| 19 | Four model presets (`fast`/`standard`/`deep`/`visual`) as an opinionated ladder | Flat catalog | Missing concept |
| 20 | Ultrabrowse disabled copy is "Upgrade to Pro and unlock Ultrabrowse for deep research and complex tasks." | "Availability must be checked in Aside." | Copy |
| 21 | Labels collapse at 384 px viewport / composer container `sm` | Always labelled | **Do not copy** (§8.9) |
| 22 | Dictate in composer | None | **Do not copy** (§8.8) |
| 23 | Incognito mode selector inside `+` | None | **Do not copy** (§8.8) |
| 24 | Side panel is a tRPC client of the local daemon | CLI + files + SQLite | Architecture |
| 25 | Icons: filled 24 px set + Radix strokes | Lucide strokes + custom inline | Convention, not geometry |
| 26 | `Aside Display` variable font ships | Not used | Optional |

---

## 7. Prioritised required updates

### P0 — small, high-confidence, unblocks the rest

1. **Re-enable `max` effort.** The CLI accepts it. Add `max` to `EFFORT_LEVELS` (`config.ts:48-56`) between `xhigh` and `ultrabrowse`, add it to `EFFORT_MENU` (`:65-71`), and replace the comment block at `:28-36` with the probe recorded in §10.1. *(§2.11, §10.1)*
2. **Composer placeholder → `Ask Aside...`** in both variants (`Composer.tsx:310-312`), ASCII dots, not `…`. One string, both states. *(§2.3)*
3. **Add `/stop` via `aside session stop <id>`**, using the session id the bridge already tracks. Do **not** reuse `_reap_stale_exec`'s `pgrep`/`SIGTERM` path: the CLI now owns this, and that path only ever ran at startup. Keep the `pgrep` reaper for its actual job — orphan cleanup at launch. *(§2.11)*
4. **Fix `docs/MINIAPP.md:20-24`** to the real argv, **re-pin `docs/ASIDE-DESIGN.md`** to `1.0.928.1` / `1.26.928.1922`, and **record the on-disk extension path plus the re-verification procedure from §1.1**. Delete the "cannot re-extract from disk" claim. *(§1.1, §5.6)*
5. **Rewrite the permission copy to Aside's shipped strings** (`Pickers.tsx:64-66`) and state the default (**Guard**) in the sheet. *(§2.6)*

### P1 — real gaps, no architectural risk

6. **Move the confirmation control into the composer row** as a pill matching `wt`: one control, current state visible as text, orange caution styling, `aria-label` = current state. Relabel **Ask first** / **Skip confirmation** with Aside's tooltips. *(§2.6)*
7. **Add the project control to the reply composer** (`Composer.tsx:412-418` is home-only), and add **re-select-to-deselect** to `ProjectSheet`. *(§2.9)*
8. **Turn `+` into a menu** with *Attach photo or video* and *Attach file* behind the existing hidden input. Do not port *Attach folder* — it is a native-only affordance that already fails closed on non-desktop. *(§2.4)*
9. **Bring the approval card up to Aside's shape** (§2.7): numbered options, Allow / Deny / a custom "tell Aside what to do instead" text option, a "Do not ask again for this action" checkbox, and deny-with-reason. On a phone the numbering is decorative, but the **custom option and the reason field are not**. *(§2.7)*
10. **Carry `vision` through and gate on it.** `desktop.ts:42` already parses it. Thread it to the client; when an image is attached, restrict the model sheet to `supportsVision` models and say so plainly if the current model cannot take images. *(§2.8)*
11. **Add a Follow-up behavior setting** mirroring Aside's `queue`/`steer` (`default "queue"`), stored in the existing preferences store, surfaced in `SettingsScreen` with Aside's own title and description. Keep the current FIFO as the queue implementation. Do **not** add a per-send chooser — Aside has none. *(§2.4, §2.8)*

### P2 — worth doing, larger

12. **Queued-message list with per-item edit and delete.** The single most interesting unbuilt feature; Aside announced it on 2026-09-24 and the shipping code carries the strings. *(§2.10)*
13. **Busy-state send semantics**: while the agent is running, relabel send to **Send now** and show *"Send at the next opportunity instead of waiting in the queue"* as visible text (not a tooltip — a phone has no hover). *(§2.4)*
14. **Add `/steer`** backed by `aside session steer <id> <prompt>`, surfaced as an explicit "Interrupt with…" action on the running-thread screen. This is the Telegram-native form of the control the desktop reaches by retyping into a live composer. *(§2.11)*
15. **Model picker parity**: provider glyph per row, provider-group headers, "No matching models" empty state, and `xhigh → "Extra High"` verified against `use-agent-settings`. *(§2.8)*
16. **Fast mode**, once `supportsFastMode` reaches the client: send `-s/--speed fast`, render Aside's treatment (a small sky dot on the provider glyph), and surface *"Significantly faster, consumes more usage"* as a caption. Disable on free-tier accounts the way Aside does. *(§2.8)*
17. **Ultrabrowse copy** → "Upgrade to Pro and unlock Ultrabrowse for deep research and complex tasks." *(§2.8)*
18. **Draft preservation** across approval/question cards, with the same reassurance line Aside shows: *"Your message draft is saved and will return when this closes."* *(§2.3)*

### P3 — evaluate separately. Do not start without a decision

19. **Aside v2 shape** — hiring a designer and an iOS engineer as of 2026-09-23. Component-level parity has a shelf life; token-level parity does not. *(§2.12)*
20. **Daemon tRPC as a data source** *(§9.1)* and **native project membership** *(§9.2)*.

---

## 8. Screen, control, and state specification

### 8.1 Home screen (new chat)

| Element | Current | Change |
|---|---|---|
| Composer placeholder | `Chat with Aside…` | **`Ask Aside...`** |
| Control row | project, permission, context ring, model, effort | layout unchanged |
| Project control | labelled pill, prompt-seeded | keep; add the sheet footnote that project is applied as workspace + `AGENTS.md` context, not native membership. That honesty currently lives only in `projects.ts:7-14` |
| Permission pill | inside the sheet | becomes its own labelled pill in the row (§8.3) |
| Empty state | resting hero | unchanged; `rest.test.tsx` already pins it |

### 8.2 Reply composer (in a thread)

| Element | Current | Change |
|---|---|---|
| Composer placeholder | `Reply to Aside…` | **`Ask Aside...`** |
| Project control | **absent** | add, same component as home |
| Stop / send | 30 / 34 px icon-only | keep the icons; **44 px and 48 px hit areas** (§8.9). While streaming, label send **Send now** + the queue caption |
| Queue | invisible | show a queued-message chip with edit and delete *(§7.12)* |

### 8.3 The permission + confirmation pill

One control, in the composer row, matching `wt`'s anatomy: **icon + current label + chevron**, `text-xs`, `data-slot="agent-session-permission-trigger"`, `aria-label` = current state.

- The trigger shows the **permission mode**. A secondary affordance (a long-press, or a visible "confirm" segment — not a hidden menu) opens the mode + confirmation sheet.
- **Orange** (`--color-orange-500` / `--color-orange-400`) when the mode is **Full access**, or when confirmation is **off** where it is expected to be on. Nothing else is orange. Do not use orange for destructive project actions or error toasts.
- Sheet contents, in order, matching §2.6: a **Permission** group of three rows (icon, label, description **inline** — not in a tooltip), a separator, a **Final confirm** switch with *Ask first* / *Skip confirmation* and its description inline, and a **Global setting** row.
- **Do not port** the hidden *Developer* group.
- Persist the last confirmation choice in the bridge's own store. Do **not** reuse the key `aside.last-final-confirm.v1` — that is the sidebar's `localStorage`, unreachable from a phone, and coupling to it would be a silent no-op.
- When the mode is **Read only**, disable Final confirm and explain: *"Read only cannot take actions, so Final confirm is off."* The bridge can support this string; the desktop hides the whole control instead.

### 8.4 The approval card

Rebuild `QuestionCard.tsx` to Aside's shape (§2.7). On a phone:

- Header: **"Allow Aside to do this action?"** plus the concrete action, not a generic "Approve?".
- Options as **full-width rows ≥ 48 px**, text left, no numbering (numbers are a keyboard affordance and a phone has none).
- **Three options: Allow, Deny, and a free-text "tell Aside what to do instead" textarea.** The third is the important one — on a phone it is much cheaper to type than to reconstruct context in a reply.
- A **"Do not ask again for this action"** checkbox, default checked, with an honest scope note. The bridge must state that this suppresses *this* action class, not all future ones.
- **Deny with a reason** must remain available. It is a supported mutation parameter in the shipping API, not a workaround.

### 8.5 Icons

Keep `lucide-react` and the transcribed marks in `Brand.tsx`. Adopt the **contract** from §4.1, not the glyph data:

- Author on a 24 px grid, render at 16 / 20 px, scale optically.
- `currentColor` only. No per-icon baked colour.
- `aria-hidden="true"` on every decorative glyph; the accessible name lives on the control.
- **One optical weight.** The bridge currently mixes `strokeWidth` 1.75 and 2 in `Composer.tsx`. Pick one and apply it everywhere.
- Provider marks: use the real transcribed SVG, not a Lucide stand-in. At 15 px a stand-in is the whole difference.
- Keep the two pre-shaded `AsideLogo` variants (`dark:hidden` / `hidden dark:block`) — Aside does it the same way. **[src]**
- `AsideDisplay-Variable-LuohODSt.woff2` is available if the bridge ever wants Aside's display face. It is a web font; budget the bytes before adding it. **[src]**

### 8.6 Page context

The bridge's decision to drop `@ for context` is **correct and should stand** — tab inventory requires `tabs`, `activeTab` and `webNavigation` host permissions that a Telegram client cannot have (§2.2).

One honest extension is available: if the user names a URL (Telegram message, share sheet, `/project` argument), offer it as an explicit context chip with title, host and Remove, matching the desktop pill in shot 5. Never auto-attach a page the user did not name. If nothing supplied a URL, show no chip and no affordance.

### 8.7 Projects: keep them separate from permission

The shipped **side panel** keeps project and permission as two separate controls in the composer row; only the **mini popup** combines them into a `w-72` "Projects & permissions" surface. **[src]**

For a phone: **combine them in the sheet, keep two controls in the row.** Two labelled pills in a row stay readable at 390 px; one merged pill loses the current mode at a glance. The sheet is where the long descriptions fit.

- Row triggers: labelled, not icon-only (§8.9).
- Project sheet: existing list, plus **re-select to deselect**, plus **create project** (name + optional workspace path). Keep the prompt-seeding footnote.
- Show the workspace path as a subtitle when two projects share a name (already implemented).

### 8.8 What must not be copied

| Desktop behaviour | Why not |
|---|---|
| **Dictate / mic** | The phone OS already provides dictation. A second mic competes with it, needs its own permission prompt, and has no transcription pipeline in the bridge. |
| **Icon-only composer controls** | See §8.9. |
| **Label collapse at `max-sm` / `@max-sm/composer`** | This is a desktop panel running out of horizontal room at 384 px. A phone has ~390 px for the entire screen and a thumb instead of a cursor. Collapsing there trades away the one thing that makes a control usable. |
| **Incognito mode** | It is a browsing-history concept, and `aside-bridge` has no history to withhold. Aside itself gates the control on `onModeChange` being present. A dead toggle is worse than no toggle. |
| **Hidden "Developer" permission section** | Memory-extraction and password-access toggles have no bridge-side meaning. |
| **Press-and-hold to move a session to a project** (500 ms, 10 px threshold) | Hostile on glass: it collides with scroll, long-press selection and context menus. Use an explicit labelled action. |
| **Provider auth-state rows in the model picker** | The bridge has no provider connect flow. Do not render a row it cannot action. |
| **`Meta+Shift+.`, `Cmd+Enter`, arrow-key selection, numbered options** | Keyboard affordances. Show the *meaning* as visible text instead (§8.4). |
| **Tooltip-only explanations** | There is no hover on a phone. Every Aside explanation that lives in a tooltip — permission descriptions, the effort menu header, "Significantly faster consumes more usage", the send-while-busy queue note — must become **inline text** in the bridge. |

### 8.9 Mobile-specific rules

Aside's composer controls are 24–28 px tall at every width, with **no** narrow-width touch compensation (§2.5). That is correct for a pointer with a visible hover affordance, and below every mobile guideline. The bridge is already 28–34 px and still under-sized.

| Target | Minimum |
|---|---|
| Any tappable control | 44 × 44 CSS px hit area |
| Send, stop, attach | 48 × 48 |
| Sheet rows (model, project, permission, effort, approval options) | 48 px row height, full width, text left, check right |
| Composer-row pills | 32 px visual height, 44 px hit area via padding or a pseudo-element |
| Gap between adjacent pills | ≥ 8 px |

**Icon-only controls.** If a control collapses to an icon on the bridge, it needs all three of: an `aria-label`, a way to reveal the current value as text without opening a sheet, and a **distinct glyph per state**. Aside gets away with more icon-only density because it has hover tooltips, keyboard shortcuts and a pointer; a phone has none of the three. Aside also keeps the states distinguishable by giving each a different glyph (hand vs skip-forward, §3). **The bridge's current labelled pills are the correct call and should not be collapsed** — this is the clearest place where the desktop's compact treatment should *not* be copied.

Accessible names are non-negotiable, and the bridge is already right here: `aria-label="Attach files"`, `"Stop"`, `"Send"`, `"Permission"` (`Composer.tsx:358, 386, 396, 203`). Keep them, and add explicit names to the model and effort pills, which currently rely on visible text only (`Composer.tsx:132`) — fine while labelled, a gap the moment truncation or a sheet removes the label.

---

## 9. Larger questions, deliberately not recommended

### 9.1 The Aside Daemon tRPC surface

The sidebar gets models, projects, settings and session state from `127.0.0.1:21420/trpc/*` (§2.1). That is a typed, structured source where the bridge parses JSONL, two model catalogs and read-only SQLite.

**Not a recommendation.** The surface is undocumented, authenticated via `/auth/daemon/verify`, bound to loopback, and has no stability contract. It sits behind a different trust boundary than the CLI, which the bridge can invoke deliberately. Adopting it couples bridge uptime to a private daemon API that can change without notice.

Worth a spike **only** if the JSONL/SQLite parsing becomes the actual bottleneck. Two specific candidates if it does: `models.listSettingsInventory` (would resolve P2 items 10, 15, 16 and 19 in one shot) and `sessions.get` + `sessions.turns.list` (would replace the file-watching and delta machinery).

### 9.2 Native project membership

`server/src/projects.ts:7-14` records that `aside.sessions.update` silently ignores `projectId` and `cwd`, so the bridge seeds project context into the first prompt. The observation was correct when made and the honest labelling is right.

But the shipping sidebar demonstrably **does** set a project — `fo` takes a `draftProjectId` and passes it into the create-session path, and the running sidebar calls `sessions.update` **[src]**. So something accepts it. **Which surface accepts it is unknown.** **[gap]**

Until that is answered: keep prompt seeding, keep the honest footnote, and do not build a move-existing-session control. Re-run `aside.sessions.update` against a throwaway session to settle it.

---

## 10. Open questions and inspection gaps

**10.1 `--effort max` — resolved this pass. [cli]**
`aside exec --help` on `1.26.916.1741` lists `max` among the choices. To separate "the help text was regenerated" from "the validator accepts it", two probes were run with a deliberately invalid `--host`, so Commander's choice validation runs first and the host lookup fails afterwards:

```
$ aside exec --effort max       --host __definitely-not-a-host__ "probe"
Remote hosts lookup failed: 403                        <- reached the action; max passed validation

$ aside exec --effort __nope__  --host __definitely-not-a-host__ "probe"
error: option '--effort <effort>' argument '__nope__' is invalid.
Allowed choices are off, minimal, low, medium, high, xhigh, max, ultrabrowse.
```

**`max` is accepted by the CLI.** The comment at `config.ts:28-36` quotes an error from an older build and should be replaced with these two commands and their date. Still unverified: whether the **daemon honours `max`** for a given model, or silently clamps it. `availableThinkingLevels` is per-model, so the bridge should only offer `max` for models that declare it — which needs the catalog field threaded through. No billed turn was started to test this.

**10.2 The queued-message pick-and-edit interaction.** Announced 2026-09-24; shipping code contains the strings ("Queued messages", "Edit message", "Cancel queue edit", "Failed to edit the message.") but the exact layout was not isolated. **[gap]**

**10.3 Icon library attribution.** System A's contract is fully verified (§4.1); the upstream library is not. The previous revision's "Phosphor" claim is withdrawn. This does not block anything, because §8.5 recommends keeping the bridge's own library. **[gap]**

**10.4 Project glyph tints in the screenshots.** Source says identity is `color` + `icon` **[src]**; the specific projects in the shots could not be identified. Low impact. **[gap]**

**10.5 `Space Bunny Free` as a model label.** Observed in shot 5, present in neither the extension assets nor `models.json`. Almost certainly a per-install tier codename. **[gap]**

**10.6 `Aside v2`.** Announced 2026-09-23 (designer + iOS hires). Nothing here is pinned to a v2 surface, but the risk is real. **[discord]**

**10.7 Official Aside Telegram surface.** A Discord search for "Telegram" surfaced something labelled *Telegram* in the server's announcement area; the visible channel sidebar lists only `rules`, `announcements`, `welcome`, `general`, `help`, `use-cases`, `ideas` and `feature-request`, and I could not open or confirm the result. **Whether Aside ships an official Telegram bot is unresolved, and it materially affects the bridge's long-term position.** Worth resolving before more parity work. **[gap]**

**10.8 Not inspected.** Aside's Slack channel handler, the new-tab page, the omnibox, the Aside Vault, the passkey manager, and `background.js` (352 KB) in detail. The Slack handler is the closest analogue to the bridge's own surface and deserves its own comparison before any channel-parity work.

**10.9 Decay.** Every claim here is pinned to Aside `1.0.928.1` / agent `1.26.928.1922` / CLI `1.26.916.1741`. The CLI trails the extension by twelve builds, so CLI-derived conclusions decay fastest. Re-verify with the procedure in §1.1 after any browser update.

---

## 11. What was checked, and how

**Aside extension, on disk (§1.2).** `manifest.json` in full; `sidepanel.html` in full; `permission-selector-CQjlToxh.js`, `session-permission-templates-B6KOByww.js` and `thinking-levels-DLuCdpvc.js` in full; `session-composer-BbMCYIxX.js` by targeted byte-range slices around the placeholder, the effort menu, the project picker, the `+` menu, send/stop and the narrow-width classes; `permission-approval-Ddj-0iBE.js` around the approval card; `globals-d32IVJ-N.css` for tokens, radii and `@font-face`; the icon-chunk population by content signature; three representative icon chunks in full; string tables for the composer, the settings surface and the new-tab editor.

**Aside CLI.** `--version`; `exec --help`; `--help`; `session --help` plus `stop`/`queue`/`steer`/`resume` subcommand help; `settings --help`; two `--effort` probes (§10.1).

**Aside Discord.** `#announcements`, 2026-09-19 → 2026-09-29, read from the signed-in web session; a search pass for "Telegram" (§10.7).

**`aside-bridge`.** `bridge.py`, `miniapp/server/src/**`, `miniapp/web/src/**`, `docs/**` and the test suites, in the current working tree (which has uncommitted Mini App changes). Git `HEAD` is `5581931 fix: mirror Aside model inventories`.

**Screenshots.** All five at full resolution, plus reconciliation of their strings against shipping source (§3).

**Side effects.** Read-only throughout. No Aside session was created, steered, stopped or modified; no Discord message was sent, edited or reacted to; the Discord search box was cleared and the tab left on `#announcements`; no file outside this document was written. Both CLI probes failed before doing any work and started no turn.

**Not verified by execution.** Whether the daemon honours `--effort max`; whether `session stop`/`steer`/`queue` interact safely with a bridge-owned child process; whether `--permission` changes what the facade write does; `aside.sessions.update` project handling; and the entire Telegram surface beyond source reading.
