---
name: Lore Studio
description: The local developer inspector for one immutable Lorepack context build.
colors:
  bg: "#fafafa"
  surface: "#ffffff"
  surface-raised: "#f4f4f5"
  surface-sunken: "#f4f4f5"
  sidebar: "#f3f4f6"
  border-subtle: "#e7e7ea"
  border: "#d4d4d8"
  text-muted: "#67676f"
  text-secondary: "#3f3f46"
  text: "#18181b"
  ink: "#18181b"
  ink-text: "#fafafa"
  ink-hover: "#3f3f46"
  selected: "#ebebee"
  overlay: "rgb(24 24 27 / 0.32)"
  state-ok: "#15753a"
  state-warn: "#8f4a07"
  state-bad: "#b42318"
  state-ok-bg: "#e9f7ee"
  state-warn-bg: "#fdf3e2"
  state-bad-bg: "#fdecea"
  bg-dark: "#0f0f11"
  surface-dark: "#161618"
  surface-raised-dark: "#1f1f22"
  surface-sunken-dark: "#121214"
  sidebar-dark: "#0d0e12"
  border-subtle-dark: "#242427"
  border-dark: "#36363b"
  text-muted-dark: "#8e8e97"
  text-secondary-dark: "#b8b8bf"
  text-dark: "#ededef"
  ink-dark: "#ededef"
  ink-text-dark: "#111113"
  ink-hover-dark: "#c9c9cf"
  selected-dark: "#26262a"
  overlay-dark: "rgb(0 0 0 / 0.56)"
  state-ok-dark: "#5fd28a"
  state-warn-dark: "#f2b84b"
  state-bad-dark: "#ff8a80"
  state-ok-bg-dark: "#10261a"
  state-warn-bg-dark: "#2a1f0a"
  state-bad-bg-dark: "#2d1414"
typography:
  headline:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  body:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  body-sm:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1
  input-lg:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  mono-id:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 500
  mono-data:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.surface-raised}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-small:
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  badge-ok:
    backgroundColor: "{colors.state-ok-bg}"
    textColor: "{colors.state-ok}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  badge-warn:
    backgroundColor: "{colors.state-warn-bg}"
    textColor: "{colors.state-warn}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  badge-bad:
    backgroundColor: "{colors.state-bad-bg}"
    textColor: "{colors.state-bad}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  badge-idle:
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  nav-link:
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  nav-link-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  nav-link-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px"
  capability-chip:
    backgroundColor: "{colors.surface-sunken}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 7px"
  data-table-header:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    height: "34px"
  data-table-row:
    typography: "{typography.body-sm}"
    padding: "6px 12px"
    height: "36px"
  palette:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    width: "640px"
  palette-option-active:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "38px"
---

# Design System: Lore Studio

## Overview

**Creative North Star: "The Developer Inspector"**

Lore Studio sits beside browser DevTools and a terminal without apology. It is a persistent sidebar, a quiet route header, and list and detail panes in which the evidence (paths, build ids, ranges, rows) is the content. Nothing on screen is decoration: a surface exists because it frames one group of evidence, and a mark of colour exists because something has a state.

The world is restrained neutral zinc in two peer themes, light and dark, each defined once and resolved before first paint. The sidebar sits on a second, slightly offset neutral so the shell reads as furniture and the route reads as the work. There is no accent hue. Selection, focus and the primary action are carried by ink contrast: near-black on light, near-white on dark. Green, amber and red appear only for state, and always beside a word.

Density is a developer's density: 14px body, 36px rows, 12.5px data in mono with tabular figures, aligned key-value facts that echo what `lore build` prints. Motion is limited to 120 to 200ms state changes, the palette rising, and the build id settling when a rebuild lands.

**Key Characteristics:**
- Neutral zinc, two peer themes, no accent token.
- Colour encodes state only, always with a word or a dot beside it.
- Hairline 1px borders; 8px controls, 12px panels, pills for status.
- IBM Plex Sans for the interface, IBM Plex Mono for every id, path, number and query.
- Authored 16px line icons at 1.5 stroke, in the shell only.
- One animated moment of truth: the build id settles when a rebuild lands.

## Colors

A neutral ladder carries every surface, line and word; three state scales are the only chroma in the product.

### Primary
- **Ink** (`ink`, light; `ink-dark`, dark): the primary action fill, the skip link, the confirmation frame and the text-selection highlight. It is the same value as body text on purpose: weight comes from contrast, not from hue. Hover steps toward the secondary text value (`ink-hover`).

### Neutral
- **Chalk Ground** (`bg`): the page behind routes.
- **Clean Sheet** (`surface`): panels, table frames, inputs, buttons, the active nav pill, the palette.
- **Raised Tint** (`surface-raised`): hover fill for buttons, nav links and icon buttons; the empty track of the budget tape.
- **Sunken Tint** (`surface-sunken`): table headers, segmented-control wells, command blocks, capability chips, the palette footer, row hover.
- **Shell Zinc** (`sidebar`): the sidebar column, a measurably cooler zinc than the ground in both themes.
- **Hairline** (`border-subtle`): panel borders, fact and row rules, internal dividers.
- **Control Line** (`border`): control borders (buttons, inputs, command blocks, the palette frame, idle badges).
- **Graphite** (`text`), **Slate** (`text-secondary`), **Pewter** (`text-muted`): the three text weights. Muted is the floor for any readable text and also the hover border of inputs and the search trigger.
- **Selection Wash** (`selected`): the selected source row and the highlighted palette option.
- **Scrim** (`overlay`): behind the command palette only.

### State
- **Fresh Green** (`state-ok` on `state-ok-bg`): healthy, fresh, passed.
- **Stale Amber** (`state-warn` on `state-warn-bg`): stale, dirty, warnings, and the dashed cut marker on the budget tape.
- **Fault Red** (`state-bad` on `state-bad-bg`): failures, invalid fields, error codes.
- Idle state uses Pewter text with a Control Line outline and no fill.

### Named Rules
**The State-Only Colour Rule.** Green, amber and red mean state and nothing else. Every use sits beside a word, and badges add a 6px dot so state survives greyscale. A coloured surface is a state banner or a failure block, never emphasis.

**The Ink, Not Accent Rule.** There is no accent token, and the contrast test asserts it. Selection is a lighter or raised surface plus weight; the primary action is an ink fill; focus is a 2px ink outline. Activation and rollback are pointer changes, so they are never painted red.

**The One Definition Rule.** Each theme is defined exactly once, on `:root` and `:root[data-theme="dark"]`. There is no second dark copy inside a media query to drift.

## Typography

**Body Font:** IBM Plex Sans (with ui-sans-serif, system-ui), weights 400, 500, 600.
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SF Mono, Menlo, Consolas), weights 400, 500.

**Character:** One humanist-technical family in two cuts. Sans speaks; mono is the record. Both are vendored as woff2 so Studio makes no network request.

### Hierarchy
- **Headline** (600, 22px, 1.25, -0.02em): the route title, once per route.
- **Title** (600, 14px, -0.01em): section headings and the product name. Section headings are lowercase in markup and rendered sentence case.
- **Body** (400, 14px, 1.5): prose, nav links, inputs. Route intros cap at 68ch, section notes at 72ch.
- **Body small** (400 or 500, 12.5px): table cells, buttons, notes, citations.
- **Label** (500, 11.5px, line-height 1): badges, field labels, table headers, palette group names, legends. Never uppercase, never tracked.
- **Large input** (400, 16px): the palette query only.
- **Mono id** (500, 14px): the active build id in the sidebar. The confirmation heading uses mono 500 at 16px.
- **Mono data** (400, 12.5px, tabular): fact values, paths, ranges, SQL, numeric columns (right-aligned).

### Named Rules
**The Mono Is Data Rule.** Anything a developer might copy, compare or grep (build ids, paths, hashes, commands, ranges, counts) is mono with tabular figures. Prose and labels never are.

**The Quiet Label Rule.** Labels are small, medium-weight, sentence case. No uppercase tracking, no labels above titles.

## Layout

A two-column shell: a 248px sidebar painted full height by the grid, with its content sticky, beside a main column capped at 1240px with 32px side padding and 48px bottom padding. Each route opens with a header row (title and a one-line description left, route actions right, 24px below), then sections spaced 32px apart with headings 12px above their content.

Routes compose list and detail: Overview is a state banner over a 1.35fr / 1fr grid (facts left, source state and plan right); Sources is a table beside a 280 to 340px detail pane. Facts are an aligned two-column grid with hairline rules, deliberately not cards.

Spacing is a 4px-based scale (4, 8, 12, 16, 20, 24, 32, 40, 48); 2px and 6px appear only inside compact controls. Row height is 36px, headers 34px, controls 32 to 36px.

Below 900px the sidebar becomes a sticky top bar: build identity, an icon-only search trigger and the theme switch in one row, and the six sections in a horizontally scrolling row with a trailing fade mask. Below 480px nav icons drop. Nothing hides behind a menu.

**The Scroll In Its Own Box Rule.** Wide content (tables, long paths) scrolls inside its own positioned frame. The page never scrolls sideways, at any width or at 200% zoom.

## Elevation & Depth

Near-flat. Depth comes from tonal layering (ground, sheet, raised, sunken) and hairlines. Resting surfaces carry a 1px contact shadow in light theme only, which is removed in dark. Real lift is reserved for things that sit above the page.

### Shadow Vocabulary
- **Contact** (`box-shadow: 0 1px 2px rgb(24 24 27 / 0.04)`; `none` in dark): panels, table frames, buttons, the build identity card, active nav and segmented options (combined with a 1px inset ring).
- **Overlay** (`box-shadow: 0 16px 48px -12px rgb(24 24 27 / 0.28), 0 2px 8px rgb(24 24 27 / 0.08)`; dark: `0 24px 64px -16px rgb(0 0 0 / 0.7), 0 2px 8px rgb(0 0 0 / 0.4)`): the command palette and the version confirmation only.

### Named Rules
**The Only Overlays Lift Rule.** The soft offset overlay shadow belongs to the palette and the confirmation. Nothing else floats, and no surface nests inside another panel.

## Shapes

Gently rounded and consistent: 6px for small controls (icon buttons, chips, segmented options, copy buttons), 8px for controls (buttons, inputs, nav links, palette options, command blocks), 12px for panels, table frames, failure blocks, the palette and the confirmation. Pills (999px) are reserved for status badges, the theme switch and the budget tape track. Every border is 1px; the confirmation alone is framed in ink. The focus ring is a 2px ink outline offset 2px, everywhere, never removed (inputs use offset 0 and an ink border).

## Components

### Buttons
One button shape in the product, quiet by default.
- **Shape:** 8px radius, 32px tall, 12px horizontal padding, 12.5px medium text.
- **Default:** Clean Sheet fill, Control Line border, contact shadow. Hover fills Raised Tint over 150ms; active presses 0.5px.
- **Primary:** Ink fill and border with Ink Text; hover steps to Ink Hover. Used for the confirmed action, not for emphasis.
- **Small:** 26px tall, 8px padding, label size.
- **Disabled:** muted text at 0.6 opacity, not-allowed cursor.
- **Icon button (shell):** 26px square, 6px radius, transparent until hover. Always labelled.

### Chips
- **Status badge:** 20px pill, label type, state ink on state tint with a 6px current-colour dot; idle is outline only.
- **Capability chip:** 6px radius, 1px Control Line, Sunken Tint, label type. Facts, not filters.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** Clean Sheet.
- **Shadow Strategy:** contact shadow only (see Elevation).
- **Border:** 1px Hairline.
- **Internal Padding:** 20px (panels), 16px (task form, list items).
- One panel per group of evidence, never nested.

### Inputs / Fields
- **Style:** 36px, 8px radius, 1px Control Line on Clean Sheet, 14px body, muted placeholder. Selects use a drawn chevron, not the native arrow.
- **Hover:** border darkens to Pewter.
- **Focus:** 2px ink outline at 0 offset with an ink border.
- **Error:** Fault Red border with a Fault Red message below.
- **Segmented control:** a sunken 8px well with 3px padding; the active option is a Clean Sheet tab with a 1px inset ring.

### Navigation
- **Sidebar:** brand, build identity card (name, mono id with copy, freshness badge), search trigger with the Cmd-K hint, six nav links with icons, theme switch pinned to the foot.
- **Links:** 34px, 8px radius, Slate text; hover fills Raised Tint; active becomes a Clean Sheet pill with a hairline inset ring, contact shadow and 500 weight, and its icon darkens to Graphite.

### Data Table
Sits in a 12px framed box. 36px rows with hairline rules, a 34px Sunken Tint header in label type, row hover in Sunken Tint, numeric cells right-aligned mono. The selected row uses Selection Wash.

### Command Palette (signature)
Opened with Cmd-K or Ctrl-K. A 640px sheet, 14vh from the top, over the Scrim, with the overlay shadow. A 52px search row at 16px, grouped options at 38px with a 16px icon, label and mono detail; the highlighted option takes Selection Wash. A Sunken Tint footer carries key hints. The scrim fades in 160ms and the sheet rises 6px from 0.985 scale in 180ms.

### Budget Tape (signature)
Playground's accounting drawn to scale: a 10px pill track, reserved tokens in Pewter, selected in Graphite, free space as Raised Tint with an inset line, segments split by a 2px surface gap, and the cut marked with a 1.5px dashed Stale Amber border. A mono legend with the exact figures sits beneath. Built from elements, not SVG.

### Confirmation
Inline under the version it acts on: Clean Sheet, 1px ink frame, 12px radius, overlay shadow, a mono heading naming the build, the plan, and the actions behind a hairline. It enters by moving 4px over 200ms and never fades.

### Citation
Path in mono 500, heading path in muted sans, range in muted tabular mono, real-space separators. Inline layout so it wraps on the baseline. The copy button appears on hover or focus, and always on touch.

## Do's and Don'ts

### Do:
- **Do** carry selection, focus and the primary action with ink contrast and weight (the State-Only Colour Rule, the Ink, Not Accent Rule).
- **Do** put every id, path, hash, command, range and count in IBM Plex Mono with tabular figures.
- **Do** use 8px radius for controls and 12px for panels, with 1px hairlines.
- **Do** keep state colour beside a word, and give badges their 6px dot.
- **Do** time hover and selection changes at 150ms on `cubic-bezier(0.16, 1, 0.3, 1)`, and let reduced motion remove all of it.
- **Do** let wide content scroll inside its own frame.
- **Do** keep icons to the shell: authored 16px line icons at 1.5 stroke, each beside a word.

### Don't:
- **Don't** introduce an accent hue, or colour a button to make it important.
- **Don't** add inline SVG to route bodies: charts, gauges and scores drawn as bars are out. The budget tape is accounting with exact figures beside it.
- **Don't** use stat tiles or metric cards; facts are an aligned key-value list.
- **Don't** use decorative gradients or glass. The narrow-screen nav fade is a functional scroll cue, not ornament.
- **Don't** put the overlay shadow on anything but the palette and a confirmation, and don't nest panels.
- **Don't** fade a confirmation or any text a reader must read immediately; move it instead.
- **Don't** use uppercase tracked labels or a label above a title.
- **Don't** ship an unlabelled icon button.
