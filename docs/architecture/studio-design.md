# Studio design

Lore Studio is a developer inspector for one immutable context build. It
belongs beside browser DevTools and a terminal: a persistent sidebar, a quiet
page header, and list and detail panes where the evidence is the content.

The direction contract lives in [`DESIGN.md`](../../DESIGN.md), with the
machine-readable tokens in [`.impeccable/design.json`](../../.impeccable/design.json).

## Product truths

- The build is the source of truth, so the sidebar names the active build and
  its source freshness on every route.
- Provenance stays visible on results, context items, and table rows.
- Studio is local-first and read-mostly. Every action that changes anything
  shows a plan and names the build before it runs.
- Colour encodes state and nothing else. Selection, focus, and the primary
  action are carried by ink contrast, not by an accent hue; the contrast test
  asserts there is no accent token.

## Shell

| Part | Behaviour |
|---|---|
| Sidebar | Project, active build id with copy, freshness, Jump to, six sections, theme switch |
| Command palette | <kbd>⌘K</kbd> or <kbd>Ctrl K</kbd>: routes, sources, tables, theme and copy actions |
| Theme | System, light, or dark. Resolved before first paint in `index.html`, stored per browser |
| Narrow screens | Below 900px the sidebar becomes a top bar and the sections a scrolling row; nothing hides behind a menu |

Icons are authored 16px line icons at 1.5 stroke and appear only in the
shell. Route bodies carry no SVG, because inside a route an SVG is how a chart
or a gauge starts, and the route tests assert there is none.

## Typography

IBM Plex Sans carries the interface. IBM Plex Mono carries paths, hashes,
commands, IDs, SQL, and numbers. Both are vendored, so Studio makes no network
request. Numeric columns use tabular figures.

## Tokens

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FAFAFA` | `#0F0F11` |
| `--surface` | `#FFFFFF` | `#161618` |
| `--sidebar` | `#F3F4F6` | `#0D0E12` |
| `--border` | `#D4D4D8` | `#36363B` |
| `--text` | `#18181B` | `#EDEDEF` |
| `--text-muted` | `#67676F` | `#8E8E97` |
| `--ink` | `#18181B` | `#EDEDEF` |
| `--state-ok` | `#15753A` | `#5FD28A` |
| `--state-warn` | `#8F4A07` | `#F2B84B` |
| `--state-bad` | `#B42318` | `#FF8A80` |

Controls use an 8px radius, panels 12px. Panels carry a hairline border and,
in the light theme only, a 1px contact shadow; only overlays (the palette, a
confirmation) are lifted with a soft shadow.

## Motion

Hover and selection changes take 150ms. The palette rises in 180ms. The build
id settles with a short blur when a rebuild lands, the one moment the truth
moves without the reader acting. Confirmations move but never fade, because
text mid-fade fails a contrast audit. Reduced motion removes all of it.

## Anti-brief

No gradients as decoration, no glass, no decorative charts, no stat tiles, no
scores drawn as bars or gauges, no unlabelled icon buttons. The Playground's
budget tape is accounting drawn to scale, with the exact figures beside it.
