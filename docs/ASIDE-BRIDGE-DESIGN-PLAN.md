# Aside Bridge design and UI plan

**Status:** implementation complete; owner verification pending after the latest composer styling change.

**Reference checked:** Aside Framework `1.0.922.1`, containing Aside Browsing Agent `1.26.923.310`, inspected 2026-09-23. The installed package exposes the browser sidepanel and a compact `mini-popup` variant, not a separate native mobile app. This plan carries over their visual language and adapts the controls for the Mini App's phone-sized surfaces.

## Goal

Make the Mini App feel unmistakably like Aside: the same quiet typography, neutral surfaces, concise controls, icons, selection states, and motion. Preserve the phone's practical differences: reachable controls, readable text, safe-area spacing, keyboard-safe composition, and touch-sized choices.

The main repair is to bring component anatomy and styling back in line with the shipped Aside UI. Keep existing Mini App navigation and session behavior; recent-session discoverability is out of scope.

## Design rules

1. Treat the installed extension bundle as the visual source of truth. Refresh this plan's reference version when Aside updates; do not use old comments as proof of current parity.
2. Reuse the Aside design vocabulary: Geist, neutral black/white alpha surfaces, restrained sky links, orange full-access state, subtle hairlines, compact hierarchy, and short transitions.
3. Adapt menu contents and placement for phones; do not scale desktop hit targets down. Phone options need at least 44px interactive height, and inputs must stay at 16px or larger to avoid iOS focus zoom.
4. Use one data model for each selector and one shared row vocabulary. Desktop/tablet can use anchored menus; narrow phone layouts can use a bottom sheet with the same grouping, icon, selected-check, and pressed-state rules.
5. Do not expose a visual control for a capability the bridge cannot execute. Extend the server contract only with safe capability metadata from Aside's authoritative catalog; never send credentials or provider transport details to the client.
6. Keep bridge-specific truth in the interface. For example, the phone's confirm-before-acting behavior is not Aside desktop's native Final confirm tool and must not be relabelled as if it were.

## Work plan

### 1. Refresh the design reference and tokens

**Current difference:** `docs/ASIDE-DESIGN.md` describes an earlier extension version and says some details match more closely than the current source does. The Mini App has a warm light page surface; the installed extension's light background token is white. The bridge's sheet uses a 24px blur and an opaque page-colored sheet body; Aside's `bg-glass` selector surface is about 80% opaque with an 8px blur.

**Changes:**

- Update `docs/ASIDE-DESIGN.md` with the installed path/version, current composer pair, current project and model menus, current permission selected state, current activity timeline, and the mobile-only choices below.
- Align `--background`, foreground, border, muted, brand, permission, radius, and hairline values in `miniapp/web/src/theme/tokens.css` with the installed `globals-*.css`. Default light page to Aside's neutral white; retain a phone-only page treatment only if rendered comparison proves it is needed for separation.
- Replace generic warm or extra-colored treatment with Aside's neutral alpha surfaces. Keep sky for links/brand and orange for full access. Do not introduce a new accent palette.
- Match the installed Geist and Geist Mono stacks. Keep the bundled Geist fallback for Mini App devices; do not copy proprietary font files from the app bundle into this repository.
- Match the `bg-glass` color, blur, border, and shadow recipe for floating picker surfaces. Use the compact Aside menu treatment inside phone sheets as well.
- Keep the existing 20px composer card, 16px input, safe-area insets, and dark-mode support unless rendered evidence shows a specific mismatch.

**Acceptance:** both themes use the same visual token relationships as the current extension; menus visibly float above the page; the composer remains legible and stable when the phone keyboard opens.

### 2. Establish a shared responsive picker surface

**Current difference:** projects, models, and reasoning use large bottom sheets, while Aside presents these as compact, grouped menus. Permission alone uses the bridge's anchored popover, and its selected row has a persistent fill.

**Changes:**

- Keep one selector content model and render it through an adaptive surface: anchored Aside-style menu where there is room; a bottom sheet on narrow phones.
- In a phone sheet, retain a short title, compact group headings, flat rows, hairline separators between groups, and a neutral background. Remove card-within-card styling and large blank header/body space.
- Use a 44px minimum row target on phones. Keep 28–32px density only in anchored pointer menus. Give the full row the hit target rather than enlarging its icon badge.
- Use a trailing check as the persistent selected state. Keep selected text neutral and remove persistent selected-row fill. Reserve the muted/accent fill for hover, keyboard focus, or pressed feedback.
- Keep leading provider/project/permission icons at Aside's small scale and bare on the menu surface. Avoid decorative colored circles around provider marks.
- Keep opening/closing motion within 100–150ms, honor reduced-motion preferences, constrain menu height to the visible viewport, and keep scrolling inside the picker.

**Likely code:** `Popover.tsx`, `Sheet.tsx`, `ModelSheet.tsx`, `ProjectSheet.tsx`, `Pickers.tsx`, and the picker/sheet sections of `theme/components.css`.

**Acceptance:** every picker has the same row, heading, selected, pressed, and surface vocabulary in both themes; on a 390px phone there is no clipped menu, tiny hit target, horizontal overflow, or menu hidden behind the keyboard.

### 3. Bring the project control and selector into parity

**Current difference:** the project trigger keeps its text at most phone widths. The bridge's project bottom sheet shows filesystem paths under project names, has no visible selected check, and supports a small icon/color allowlist. Aside uses a compact ghost pill, hides the name at its small breakpoint, and shows a radio-style project list with the project's own icon and color.

**Changes:**

- Style the trigger as a quiet Aside pill: 16px project glyph, project name when the composer has room, and muted half-strength chevron. Use a container-width rule so the label hides based on the actual composer space, not only the whole viewport width.
- Use Aside's supported project icon/color map rather than the current partial allowlist. Keep unknown values neutral and legible in both themes.
- In the phone sheet, show a “Projects” group, “No project” at the top, then one-line project rows with bare tinted glyphs and names. Remove workspace-path subtitles from the default list; show path only where needed to distinguish duplicate names.
- Add a visible trailing check for the selected project, including “No project”. The current project's state must be obvious each time the picker opens.
- Put deselect behavior on “No project”; picking a project closes the surface and updates the trigger immediately.
- Do not copy Aside's “Use an existing folder” action until a phone-safe folder-selection route exists. The desktop extension's native directory picker cannot be triggered from Telegram/PWA. If a phone-safe create flow is added later, make it a separate explicit row and state its limitations honestly.

**Likely code:** `ProjectSheet.tsx`, `utils/projects.tsx`, the project pill in `Composer.tsx`, and `theme/components.css`.

**Acceptance:** at narrow width the trigger cannot crowd model/permission controls; every project uses its real icon/color or a neutral fallback; selected project is always marked; there are no path strings competing with names in the common case.

### 4. Rebuild the model selector around Aside's model menu

**Current difference:** the first bridge view lists only the active provider's models. Search and other providers are hidden behind “More models”. Model names use the longer catalog label; rows include context-window subtitles; provider marks are placed in 34px circles. Aside's compact menu starts with search, groups matches by provider, prioritizes the selected provider, and uses short model names with small bare provider marks.

**Changes:**

- Make search available immediately, not after drilling into another screen. Search provider, short name, display name, and ID; normalize common `gpt-` spelling as the installed menu does.
- Show the active provider first, then other providers as labeled groups. Searching should reveal matching models across all providers without a separate provider-navigation step.
- Use the provider mark at 16px and the short model label on each row. Keep full provider/model identifiers available in the picker where ambiguity requires them, not in the compressed composer trigger.
- Use a trailing check only for the selected model. Keep selected text and row fill neutral.
- Remove context-window sublabels from ordinary model rows; show those details only in a secondary detail/tooltip surface if they help a real choice.
- Keep “Settings” as a quiet final menu action if it remains in the official current menu. Do not let it look like a model row.
- Keep provider/model ordering and defaults sourced from the live catalog; do not add a stale client-side model list.
- Add safe `shortName` or equivalent display metadata to the server response only if Aside exposes an authoritative value. Preserve the complete ID for requests and diagnostics.

**Likely code:** `ModelSheet.tsx`, `utils/pills.ts`, `types.ts`, and the model catalog/status response in `miniapp/server/src/`.

**Acceptance:** a model can be found with one search action from the default picker; all providers remain reachable; the active item is visibly checked; long names never expand or crush the composer row.

### 5. Match the model/effort pills and effort menu

**Current difference:** the bridge presents model and effort as two unrelated rounded pills and a standalone “Reasoning” sheet. Aside visually pairs model with effort, labels the menu “Effort”, shows a shortcut in the desktop menu, and includes model-specific options such as Fast mode when supported. Ultrabrowse has a distinct animated/gated presentation.

**Changes:**

- Keep model and effort as separate quiet borderless pills, matching project and permission. Show the provider mark and model name in the model pill and the effort label in the effort pill.
- Retain the separate effort action. On narrow phones open it as a compact Aside-style sheet headed “Effort”, with phone-sized rows and the same check-only selection style.
- Use the model's available thinking levels rather than one global list when the authoritative source provides them. Preserve the exact visible labels; abbreviate only the trigger label when width requires it.
- Add Fast mode or other provider/model options only when the selected model advertises support and the server can apply the setting. Forward only safe capability metadata. Do not show a dead or cosmetic toggle.
- Match Ultrabrowse's letter-gradient/animation and plan availability. If the account cannot use it, show the official upgrade/explanation state rather than an apparently selectable option. Respect reduced motion.
- Keep keyboard shortcuts on desktop/tablet menus only; do not show a desktop key hint in the phone sheet.

**Likely code:** `Composer.tsx`, `ModelSheet.tsx`, `utils/pills.ts`, model catalog/status types, and `theme/components.css`.

**Acceptance:** model and effort read as separate controls on desktop and phone; each offered effort is valid for the chosen model/account; keyboard hints appear only where useful; Ultrabrowse never looks available when it is not.

### 6. Tighten permission control parity without falsifying phone semantics

**Current difference:** the bridge uses a full text pill for permission over most phone widths. Its selected row receives a persistent background. The phone's confirmation behavior is intentionally different from Aside's native “Final confirm”.

**Changes:**

- Use Aside's quiet shield-and-label trigger and orange full-access state. Collapse the label using the composer's available width while retaining an accessible name and a clear full-access signal.
- Keep the permission menu's compact group heading, muted mode icons, one-line descriptions where needed, and trailing check. Persistent selection is check-only; use a surface wash only for active interaction.
- On phones, retain a 44px target and show enough explanatory copy to distinguish Read only, Guard, and Full access without requiring hover.
- Keep “Confirm before acting” and its existing phone-specific explanation. Do not rename it to “Final confirm” or imply that the desktop-only confirmation tool can be answered from the phone.
- Keep the next-message effective-time note, because it is part of the phone behavior rather than decoration.

**Likely code:** `Pickers.tsx`, `Composer.tsx`, `Popover.tsx`, and the permission sections in `theme/components.css`.

**Acceptance:** permission mode is recognizable at a glance, full access remains orange, selected state is a check, and the confirmation switch explains the actual phone behavior.

### 7. Match the composer control row while preserving phone ergonomics

**Current difference:** the main composer card already follows Aside's 20px card anatomy and corner actions, but control grouping, label breakpoints, and model/effort naming are off. The bridge intentionally keeps a 16px input and larger touch targets.

**Changes:**

- Preserve the card, attachment area, bottom-corner attach/send/stop controls, and meta row beneath the card. Avoid reworking this established structure without rendered evidence.
- Group project and permission on the left; context ring, model, and effort controls on the right. Keep control order consistent between home and thread composers.
- Drive label hiding from composer container width. Hide project/permission labels first; keep the model short name where it fits and keep effort identifiable. Let only labels truncate; icons and buttons must not shrink.
- Retain a 16px text input, safe-area-aware footer, current 30/34px corner controls, and the stop-left-of-send order. Do not trade iOS keyboard behavior for exact desktop pixels.
- Keep the 20px flat composer corner, subtle ring, and focus elevation. Match Aside's surface/border/shadow colors rather than adding another card style.
- Use the same short model/effort labels for home and reply composers so selection never appears to change between screens.

**Likely code:** `Composer.tsx`, `App.tsx`, `theme/components.css`, and `utils/pills.ts`.

**Acceptance:** controls fit at 320px, 375px, and 430px widths without horizontal panning; the input does not zoom on focus; labels only disappear when necessary and remain available in the picker.

### 8. Bring conversation activity and content details up to current Aside

**Current difference:** the bridge's work timeline uses a simple left border and small per-step rows. The latest installed turn-fold uses a more structured connector/icon gutter, compact disclosure rows, and animated expansion. The answer text is intentionally 15px on phones versus the narrow desktop sidepanel's 14px.

**Changes:**

- Update `WorkFold` to use the current connector geometry, icon gutter, status alignment, muted labels, and disclosure motion from the installed bundle. Preserve mobile visibility of disclosure affordances; do not depend on hover.
- Keep phone tap targets larger than desktop disclosure rows. Keep tool details collapsed by default except the currently running step and explicit file/subagent states.
- Preserve plain assistant text, muted user bubbles, citations, and current message grouping. Keep phone answer text at a readable 15px unless rendered tests show 14px remains comfortable on the supported devices.
- Match Aside's markdown details: underlined brand links, soft inline-code chips, transparent code bodies with a quiet language/actions header, neutral table borders, and the current streaming entrance. Retain wrapping for long code and paths.
- Keep reduced-motion behavior, avoid animating on every stream tick, and preserve the transcript's existing streaming/work state machine.

**Likely code:** `WorkFold.tsx`, `Thread.tsx`, `Markdown.tsx`, and the fold/markdown sections of `theme/components.css`.

**Acceptance:** a running turn, completed fold, expanded tool, file edit, and subagent all read as one Aside activity system; the timeline remains understandable and tappable without hover.

### 9. Sweep remaining Mini App surfaces for the same design language

Apply the shared surface, typography, state, and spacing rules to the screens that do not use the composer selectors:

- **Session list:** align row radius, spacing, title/time hierarchy, unread/running indicators, focus/pressed states, and card preview treatment with the current Aside chat-list items. Preserve whichever list/card behaviors already work; this is a style pass, not a history/navigation redesign.
- **Session panel and sheets:** keep a right-side panel only where tablet/desktop width allows; use a bottom sheet on narrow phones. Reuse the same section labels, flat rows, icon scale, borders, and surface tokens as pickers.
- **Settings:** use Aside's section headings, compact neutral rows, controls, and selected checks. Preserve clear notes that defaults apply to Mini App-created sessions and do not edit account-wide settings.
- **Files, citations, questions, errors, and subagents:** reserve color for status/meaning; align row/card borders, type scale, icon weight, and actions with Aside. Keep the bridge-specific explanations and recovery choices intact.
- **Pairing and boot states:** use the same brand mark, Geist hierarchy, neutral surfaces, and button treatment without changing pairing steps or error clarity.

This sweep should be evidence-led: compare each screen with the matching current extension component before changing it. Do not add decorative cards, gradients, or extra icons solely to make the phone screens feel fuller.

### 10. Rendered review and acceptance

Before considering the pass done:

1. Capture the current installed sidepanel and its `mini-popup` selectors as the visual reference. Record the exact Aside version used.
2. Render the Mini App in light and dark at phone widths of 320, 375, 390, and 430px; tablet at 768px; and a narrow sidepanel width. Include picker-open states, long provider/model/project names, no-project, selected-project, empty catalog, permission states, keyboard-open composer, active turn, and expanded activity.
3. Check target size, safe areas, keyboard occlusion, 200% text zoom, scrolling/clipping, reduced motion, and focus/pressed/selected states. Visual token parity alone does not establish phone usability.
4. Correct visible mismatch before updating this plan's status. Run the Mini App's typecheck, tests, and build after implementation; do not treat those checks as proof of Telegram WebView, PWA install, or physical-device acceptance.

## Explicit non-goals

- Changing the session list's discoverability or the home/Recents information architecture.
- Replacing Aside's current model catalog with a hand-maintained list.
- Copying Aside's proprietary font or compiled bundle into the Mini App.
- Pretending the phone can invoke native extension features such as the Mac folder picker or desktop-only confirmation tool.
- Changing bridge authentication, session policy, persistence, or deployment as part of the visual pass.

## Completion criteria

- The project, model, effort, and permission controls share Aside's current visual anatomy and truthful selected/availability states.
- The remaining screens use consistent Aside tokens and component states without erasing intentional phone-specific behavior.
- The app stays usable on narrow phones: no sideways overflow, keyboard-hidden actions, sub-44px picker rows, or loss of composer input focus behavior.
- The rendered comparison and automated workspace checks are recorded, with any physical-device gates called out separately.

## Implementation record — 2026-09-23

The installed extension was inspected read-only, the design reference was
refreshed, shared adaptive pickers and selector behavior were implemented, and
focused picker regression coverage was added. No catalog or account-capability
fields were invented.

`npm run typecheck`, `npm test`, and `npm run build` passed from `miniapp/` (744
tests) before the latest composer styling change. Playwright rendered light and dark at 320, 360, 375, 390, 430, and
768px. The 360px render served as the narrow sidepanel check. Open model,
effort, permission, and project selectors; global model search; duplicate
project names; empty catalogs; a full-access selection; a long model list; an
active turn; and expanded activity were reviewed. No horizontal overflow or
browser page errors appeared. Phone picker rows measured at least 44px and a
long catalog scrolled inside the sheet. Reduced-motion styling, keyboard focus,
and a 200% root-font-size text-scaling simulation were checked. The keyboard
case used a reduced browser viewport with the composer input focused; it does
not emulate an iOS keyboard. Telegram WebView, native safe-area insets, actual
browser zoom, and physical-device behavior remain manual checks. The final
model/effort pill styling change was left untested at the user's request and
needs owner verification.
