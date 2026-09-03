# Aside Design Reference

What the Aside sidepanel actually looks like, extracted from the shipping
extension, and how the Mini App mirrors it. Use this before touching
`web/src/theme/` — it is the checklist that keeps the Mini App reading as
the same product as the desktop app.

## Where the truth lives

Aside's chat UI is a component extension: **Aside Browsing Agent**. On disk:

```text
~/Library/Application Support/Aside/AsideAgentManager/<version>/
```

- `assets/globals-*.css` — the design system stylesheet (Tailwind v4,
  oklch, shadcn-style tokens). The authoritative source.
- `sidepanel.html` / `main.html` — the sidepanel chat entry points.
- `newtab.html`, `minipopup.html`, `tab-preview-player.html` — other surfaces.
- `background.js` — agent machinery, not UI.

The version is in the path. When Aside updates, a new folder appears: diff
the new `globals-*.css` against `web/src/theme/tokens.css` to catch drift.

Two ways to read the design, both proven:

1. **Static**: the token block and keyframes are plain text in the CSS.
2. **Live**: open `chrome-extension://fjdhphbdlfjogobdofoaagnlnkoibdge/main.html`
   in the Aside browser REPL. The token sheet loads even at the sign-in
   wall, and once signed in the full chat UI can be inspected and
   screenshot with `getComputedStyle` probes.

## Tokens (verified live, v1.26.902.1713)

Aside is deliberately near-neutral: almost every surface, border and muted
colour is black or white at a low alpha. The sky `--brand` is the only
chromatic accent, plus orange for full-access permission.

| Token | Light | Dark |
| --- | --- | --- |
| `--background` | white | neutral-900 `oklch(20.5% 0 0)` |
| `--foreground` | neutral-950 | `oklch(98.5% 0 0)` |
| `--primary` | `oklch(14.5% 0 0 / .95)` | `oklch(98.5% 0 0 / .85)` |
| `--muted` / `--muted-foreground` | `…/.05` / `…/.55` | `…/.15` / `…/.55` |
| `--border` | black `/.1` | white `/.1` |
| `--border-surface` | black `/.1` | white `/.15` |
| `--brand` / `--brand-content` | sky-500 / sky-600 | sky-400 / sky-400 |
| `--success` | emerald-500 | emerald-400 |
| `--destructive` | red-600 | red-400 |
| `--radius` | `0.625rem` | same |
| `--hairline` | `0.5px` | same |

`--brand-content` is used for link TEXT; `--brand` colours the underline.
Links are underlined, `text-underline-offset: 2px`, 1px thickness.

All of the above is already mirrored in `web/src/theme/tokens.css`, which
names Aside's own variables and falls through to bundled Geist.

### Fonts

- Sans: `Geist Variable` (bundled from npm).
- Mono: `Berkeley Mono`, falling through to bundled Geist Mono.
- Display/serif: `Aside Display` (proprietary, never bundled) — the one
  serif, used for the home greeting only.

### Geometry

Radii are Tailwind defaults multiplied by a squircle factor of **1.4**
(live-confirmed: 11.2px = 0.5rem × 1.4, 8.4px = 0.375rem × 1.4). EXCEPT the
composer card, which opts out of the squircle for a flat `20px`.

Scrollbars: `scrollbar-color: var(--border) transparent`,
`scrollbar-width: thin`.

## Themes

Aside runs three body themes:

- `transparent` — fully clear (offscreen/aux surfaces).
- `translucent` (the chat default) — body at **80% alpha** over the desktop
  with `backdrop-filter: blur()` on floating panels (`.bg-glass`: popover
  at 80% + blur). This is the "glass" depth of the sidepanel.
- plain light/dark via the token block.

Mini App mapping: sheets and popovers already carry `--surface-secondary` +
`backdrop-filter: blur(--blur-xl) saturate(1.4)` — the same recipe. The
thread header/composer do NOT get glass because nothing scrolls under them
(flex column, no overlap).

## Motion

Streaming markdown entrance — Aside's `sd-*` keyframes:

- `sd-blurIn`: opacity 0 + `blur(4px)` → sharp
- `sd-slideUp`: `translateY(4px)` → 0
- Applied per BLOCK as each new markdown node mounts.

Mini App: `.is-streaming > * { animation: md-blur-in 0.3s }` combines
opacity + blur + 4px rise. React only mounts new DOM nodes for newly
arrived blocks, so it fires once per block, not per streaming tick.
Disabled under `prefers-reduced-motion`.

Other Aside animation vocabulary (not yet mirrored, candidates): skeleton
shimmer via animated conic-gradient (`--shimmer-angle` @property),
`sd-markerIn` (text colour-in), scroll-mask show/hide keyframes.

Menus (Base UI dropdowns) animate 100ms: fade + zoom-to-95% + slide from
the opening edge, and animate HEIGHT when the content changes. The Mini
App's popover-in (0.14s) is in the same family; keep durations under
150ms.

## Menus and pickers (captured from the live DOM)

**Permission menu**: glass panel (`bg-glass border-glass w-72 rounded-xl
p-1.5 shadow-lg`), a muted `text-xs tracking-wide` group label
("Permission"), then radio rows (min-h-7, `rounded-lg`, icon muted-foreground
+ label, check mark absolutely at right on the selected row, hover
`bg-accent`). Rows: Read only (book icon), Guard (shield-lock), Full
access (shield). Below a hairline separator: a menu row holding the
"Final confirm" label + inline SWITCH — `h-5 w-10 rounded-full`, checked
state `bg-emerald-500`, knob carries a subtle glass texture. The Mini
App's permission popover already mirrors this (label, rows, check,
switch); the switch is `--switch-on` green in tokens.css.

**Model menu**: glass panel with a SEARCH INPUT at the top (magnifier
addon, "Search models" placeholder), providers as submenu rows (brand
mark + name + chevron), scroll region capped at `max-h-72`. The Mini
App's ModelSheet has the same search field; keep it when reshuffling.

**Reasoning menu**: group label "Reasoning" (+ kbd shortcut on desktop),
checkbox rows Low/High/Max with the check indicator at the RIGHT, and
"Ultrabrowse" rendered as per-letter rainbow text plus an animated
dual-layer gradient (the `--ultrabrowse-*` stops in tokens.css).

**Project menu**: group label "Projects", radio rows = project's lucide
icon coloured by the project colour (`text-red-400!` etc., NO chip
background), truncated name, trailing check. The Mini App matches this
now (2026-09-03, `.project-icon`): bare tinted icons in the sheet AND the
composer pill -- the earlier tinted-chip treatment was reversed at the
owner's request. "No project" keeps a neutral muted folder.

### Picker restyle (2026-09-03)

The sheets and popovers were moved from iOS grouped-list styling to
Aside's menu anatomy: `.sheet-group` lost its card chrome (flat rows on
the sheet surface, no per-row hairlines), `.sheet-row`/`.popover-row`
became short 14-15px rows with their own radius and an accent pressed
wash, group labels are 12px letter-spaced muted headers, leading icons
sit muted, the switch is Aside's 40×20 with emerald on-state, and
selected rows show ONLY the trailing check (the old `--mark-warm` text
recolour was removed -- Aside never recolours chosen-row text).

**Run fold / step rows**: text-only, `text-muted-foreground`, chevrons
that appear on hover (`opacity-0 group-hover:opacity-100`), no per-step
icons and no timeline border in the collapsed list. The Mini App's fold
rows match in spirit (mobile has no hover, so its chevrons stay visible).

## Feedback on completion

Aside plays `success.wav` when a turn completes, behind a
`completionSound` account setting (with a custom-sound upload). The Mini
App's equivalent: a `haptic('success')` notification fired on the
busy→idle edge in App.tsx. Telegram haptics are the pocket-appropriate
stand-in for a sound.

## Scroll fades

Aside masks the CONTENT at scroll edges (`scroll-fade-effect-*`) with
`mask-image` gradients — 16px (sm) / 32px — never an overlay div.
Edge-aware: the fade only shows where more content exists.

Mini App: `.thread-scroll` with `--fade-h: 24px`; App.tsx toggles
`.fade-top` / `.fade-bottom` from scroll position (4px slop).

## Composer anatomy (from the live sidepanel DOM)

The sidepanel composer is a two-part assembly, restructured in the Mini
App on 2026-09-03 to match:

1. **The card**: `bg-surface-primary`, flat `rounded-[20px]` (no squircle),
   hairline ring (`ring-border-surface`), `shadow-md/5` deepening to
   `shadow-lg` on focus-within, `overflow-hidden`. INSIDE: only the input
   (14px, transparent, no border) and round 28px controls absolutely
   positioned in the bottom corners — attach (+) bottom-left,
   stop/send bottom-right.
2. **The meta row BELOW the card**: 28px pills, `0.8rem` text,
   `rounded-full`, transparent until pressed, `text-muted-foreground`,
   chevrons at 50% opacity. Left group (grows): project pill, permission
   pill — the permission label in **orange-500** when full access, with
   shield glyph. Right group: context ring, model pill, effort pill
   ("High"). On small screens Aside hides pill labels (`max-sm:hidden`),
   keeping glyphs.

Mini App deltas, deliberate:

- Input stays at **1rem (16px)**: below 16px, iOS zooms the page on focus
  in the Telegram webview. Aside is 14px; parity is not worth the zoom.
- Meta pills 28px with `0.8rem` text (Aside's exact spec); corner buttons
  30px (send 34px) for thumb reach; input bottom padding 40px reserves the
  corner row so drafts never flow under the buttons.
- Under 340px, project/permission labels hide (glyphs remain).
- The effort pill opens the model sheet (one place to change reasoning),
  instead of a separate thinking-level popover.
- Placeholders omit "@ for context" — the @ inventory lives in the
  extension and cannot be populated faithfully from a phone.

## Thread typography

Aside sets thread/answer text at 14px in its narrow sidepanel; body base
12px, muted chrome at 55% alpha. The Mini App answers at `--text-thread`
(15px) — parity-leaning but above the mobile floor. User bubbles stay at
1rem.

## Markdown spec (Streamdown)

Aside renders answers through Streamdown, keyed by `data-streamdown`
attributes. Values worth matching (all mirrored in `.md` styles):

- Links: `--brand-content` text, `--brand` underline colour, underline.
- Inline code: soft grey chip, `overflow-wrap: anywhere`.
- Code block: transparent body, header + actions row (lang label, copy).
- Tables: transparent wrapper, hairline row borders at 50% mix.

## Verification playbook

1. `cd miniapp && npm run typecheck && npm test && npm run build`
2. Mint Telegram initData locally (owner chat_id from `config.json`,
   HMAC secret = `createHmac('sha256', 'WebAppData').update(botToken)`,
   data-check-string from decoded sorted pairs), put the RAW string in
   `sessionStorage['miniapp.initData']`, reload. Server on 127.0.0.1:8790.
3. Screenshot home + thread light and dark (force
   `documentElement.dataset.theme = 'dark'`); scroll the thread to check
   the fades; bust index.html caching with a `?v=N` query param.
4. Beware: CSS silently failing to apply is more often a nesting mistake
   in `components.css` than a cache problem — check
   `document.styleSheets` rules before blaming the server.
