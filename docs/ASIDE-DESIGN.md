# Aside Mini App design reference

Use this reference when changing `miniapp/web/src/theme/` or shared Mini App
components. The source of truth is the installed Aside Browsing Agent, not
an older stylesheet or this document's memory of it.

## Reference source

Verified 2026-09-29 against Aside Browser `1.0.928.1` and Aside Browsing
Agent `1.26.928.1922`. The separately versioned CLI was
`1.26.916.1741`:

```text
/Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/1.0.928.1/Libraries/AsideAgentManager
```

For future read-only inspection, the version-independent path is:

```text
/Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/Current/Libraries/AsideAgentManager
```

The relevant files include `assets/globals-d32IVJ-N.css`, `sidepanel.html`,
`main.html`, and the sidepanel's loaded picker and composer modules. Refresh
the version and recheck those files after an Aside update. Hashed asset
filenames change between builds. Do not copy compiled bundles or proprietary
fonts into this repository.

Read-only re-verification on the reference install (run each command
independently after setting the path):

```bash
ASIDE_AGENT_DIR="/Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/Current/Libraries/AsideAgentManager"
```

```bash
rg -l 'Ask Aside' "$ASIDE_AGENT_DIR" -g '*.js'
```

```bash
head -5 "$ASIDE_AGENT_DIR/manifest.json"
```

## Visual system

Aside is near-neutral. Use low-alpha black and white for surfaces, borders,
and muted text. Sky is the link and brand accent; orange identifies Full
access. Keep other color limited to project identity, status, and diffs.

| Token | Light | Dark |
| --- | --- | --- |
| Background | white | neutral 900, `oklch(20.5% 0 0)` |
| Foreground | neutral 950 | near-white |
| Muted | black at 5% | white at 15% |
| Muted foreground | black at 55% | white at 55% |
| Border | black at 10% | white at 10% |
| Brand | sky 500 | sky 400 |
| Full access | orange 500 | orange 400 |
| Hairline | 0.5px | 0.5px |

Floating `bg-glass` surfaces use the popover color at 80% opacity, an 8px
blur, a hairline border, and a restrained shadow. Menus open and close in
100–150ms; honor reduced motion. Use Aside's `Geist Variable` and
`Berkeley Mono` stacks, with the bundled Geist and Geist Mono fallbacks.
Never bundle Aside Display or other proprietary fonts.

## Menus and composer

Aside's model menu starts with search, groups models by provider, and shows a
check on the selected model. Its effort menu is called **Effort**. Project
rows use Aside's supported icon and color names, a bare tinted glyph, and a
selected check. Permission rows also use a check; Full access is orange.
Selected rows stay neutral and get a background wash only for hover, focus,
or pressed feedback.

The Mini App uses the same flat row vocabulary in anchored menus at 640px
and wider, and in bottom sheets below 640px. Phone picker rows are at least
44px tall and scroll inside the visible surface. Paths appear only to
distinguish projects with duplicate names. Do not add model metadata or
capability controls unless the local Aside source is authoritative and the
server can apply the choice.

The composer has a flat 20px card and a meta row beneath it. Project and
permission sit to the left; context, model, and effort sit to the right.
The Mini App keeps a 16px input to avoid iOS focus zoom, safe-area insets,
and larger touch controls. Model and effort remain separate, quiet borderless
pills like project and permission. Hide labels based on composer width, not
viewport width.

The phone's **Confirm before acting** switch uses the bridge's answerable
question-card flow. It is not Aside's desktop-only **Final confirm** tool;
keep its mobile explanation and next-message effective-time note.

## Conversation and remaining surfaces

Use a connector line and icon gutter for the activity timeline, with
disclosure affordances visible without hover on touch screens. Keep tool
details collapsed except for the running step and explicit file/subagent
states. Preserve the transcript state machine and 15px phone answer text.

Markdown links are underlined in the brand colors. Inline code uses a soft
neutral chip; code blocks stay transparent with a quiet language/actions
header; tables use neutral hairlines. Keep long paths wrapped and animation
per block rather than per stream tick. Apply the same neutral surfaces,
type hierarchy, icon scale, and meaningful status colors to session rows,
settings, files, citations, questions, errors, subagents, pairing, and boot
states. Preserve their existing navigation and explanations.

## Verification

Run `cd miniapp && npm run typecheck && npm test && npm run build`. For
visible changes, compare light and dark rendering at 320, 375, 390, and
430px, at 768px, and in a narrow sidepanel. Review picker states, keyboard
occlusion, safe areas, 200% text zoom, reduced motion, focus/pressed states,
overflow, active turns, and expanded activity. Browser rendering does not
prove Telegram WebView or physical-device behavior; report those gates
separately.
