# Studio design

The tokens and rules every Studio route builds against. Written before the routes, so there
is one document rather than five interpretations.

## What Studio is

**An instrument, not a dashboard.** Nothing here is managed; a sealed, content-addressed
build is examined. There are exactly four mutating actions in the whole application
(activate, rollback, pack, prune), and architecture 15.6 requires a plan and a confirmation
for each.

The audience already lives in a terminal. They ran `lore dev`, watched the stage table, and
opened a browser because a tree, a diff and a ranking breakdown are genuinely hard to read in
a terminal. They are not new to the domain and do not need onboarding.

**The single job: make one build legible.**

## The nearest reference is our own CLI

`lore build` and `lore dev` already print aligned monospace columns:

```text
Build           lore_4e13844420af
Reused          0 artifacts (first build)
HTTP            http://127.0.0.1:43110/v1
```

Studio should read as **that output given room to breathe**, so moving between the terminal
and the browser feels like one product. Every external reference is secondary to this.

## Typography

This product's content is overwhelmingly identifiers: `lore_4e13844420af`, `docs/runbook.md`,
`lines 9-11`, `700 tokens`, `bm25 5.43`. Prose is the minority.

**So monospace is the primary interface voice, not a code accent.**

| Role | Family | Used for |
|---|---|---|
| Identifier | IBM Plex Mono | build ids, paths, hashes, counts, ranges, scores, keys |
| Prose | IBM Plex Sans | descriptions, remediation, empty states, confirmations |

Both are Open Font License, which matters for a product that promises no account and no
download, and both ship variable. Plex has genuine character (humanist quirks, a
slab-influenced mono) rather than being neutral to the point of anonymity.

**Every numeric column uses `font-variant-numeric: tabular-nums`** so figures align down a
list. This is why a 2,500-row tree is scannable.

### Scale

Fixed steps, no fluid clamping. This is an instrument read at one distance.

| Token | Size / line height | Use |
|---|---|---|
| `--text-xs` | 11px / 1.45 | table meta, badge text |
| `--text-sm` | 12.5px / 1.5 | dense rows, secondary values |
| `--text-base` | 14px / 1.55 | body, most values |
| `--text-lg` | 17px / 1.4 | route headings |
| `--text-xl` | 22px / 1.3 | the build id in the header |

Weights: 400 body, 500 emphasis, 600 headings. Nothing heavier. Hierarchy comes from size,
weight and space, never from opacity alone.

## Colour

Colour encodes **state and nothing else**. There is no brand accent, no coloured navigation
and no coloured primary button. When a project goes dirty, the one place colour appears is
carrying real information.

### Neutrals, warm rather than blue

The blue-grey that ships as a framework default is the single clearest tell of an untouched
starter. These are warm.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FCFCFB` | `#141311` |
| `--surface` | `#F6F5F2` | `#1C1B18` |
| `--border-subtle` | `#EAE7E1` | `#26241F` |
| `--border` | `#D9D5CD` | `#332F29` |
| `--text-muted` | `#6E6960` | `#918B81` |
| `--text-secondary` | `#4A453D` | `#B8B2A8` |
| `--text` | `#1A1815` | `#EDEAE3` |

### The three state scales

These are the only colours in the interface.

| Scale | Values |
|---|---|
| Freshness | `clean`, `dirty`, `unknown` |
| Artifact status | `active`, `draft`, `archived`, `superseded` |
| Check result | `pass`, `warn`, `fail` |

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--state-ok` | `#2F6B44` | `#7FC79A` | clean, pass |
| `--state-warn` | `#8A5B14` | `#DBA94F` | dirty, warn, draft |
| `--state-bad` | `#A33A2C` | `#E89484` | fail |
| `--state-idle` | `--text-muted` | `--text-muted` | unknown, archived, superseded |

**Colour is never the only carrier of state.** Every badge pairs its colour with the word, so
the interface works in greyscale and for colour-blind readers. This is a WCAG requirement and
a legibility one at the same time.

## Space, radius, density

Developers reading a 2,500-file tree need density. Density does not mean cards.

- Spacing scale: `4, 8, 12, 16, 24, 32, 48`. Nothing between, nothing above.
- Radius: `3px` on controls and badges, `0` on table rows and panels. No `rounded-2xl`.
- Borders do the separating. Shadows are used for exactly one thing: an overlay that must sit
  above the page (confirmation dialogs). Nothing else casts a shadow.
- Row height in dense lists is uniform, so the eye can scan a column.
- Line height is tight inside a block (1.4 to 1.55) and space is generous around blocks.

**Tables and trees, not a card grid. No stat tiles. No charts.** A count is a count; these are
facts about one immutable build, not metrics trending over time, so there is no delta to plot.

## The signature element: the citation

Invariant 5 says every search result, context item and table row carries a `SourceLocator`,
and that a result without one is a bug rather than a style issue. That line is the product's
whole thesis made visible.

**One citation component, used identically everywhere provenance appears**: the Playground's
selections and omissions, the Sources detail view, the Search tab, the diff rows.

```text
docs/runbook.md · Release runbook › Rolling back · 9-11
```

- path in mono at `--text-sm`, `--text-secondary`
- heading path in sans, `--text-muted`, with `›` between segments
- line range in mono with tabular figures
- separators are `·` at `--text-muted`
- the whole thing is selectable, and carries a copy affordance on hover and on focus

This is where the design budget is spent. Everything around it stays quiet.

## Motion

One orchestrated moment: **when watch mode lands a rebuild, the active build changes.** A
150ms crossfade on the header build id, so a person watching sees the world change under
them. That is the only moment worth animating, because it is the only moment the underlying
truth moves without the user acting.

Everything else gets focus and hover state changes and nothing more. No skeleton shimmer, no
scroll reveals, no page transitions. `prefers-reduced-motion: reduce` removes even the
crossfade.

## The anti-brief

None of these ship. Each is a recognisable marker of an interface assembled from defaults
rather than designed.

- an untouched component-library look with default radii and shadows
- Inter, or a violet/indigo accent, or both
- a card grid on any route
- stat tiles with oversized numbers, delta arrows or trend lines
- donut charts, sparklines, gauges, health scores
- gradients anywhere, glassmorphism, `rounded-2xl` as a default
- emoji or sparkle characters in the interface
- a marketing-style hero on Overview
- skeleton shimmer loaders

A design review against this list is recorded before Phase 4 closes.

## References, each for one decision

Secondary to our own CLI.

- [Vercel's Geist](https://vercel.com/font): monospace as a first-class interface voice, a
  disciplined neutral ramp, flat low-radius controls.
- [Sentry's stack traces](https://sentry.io/features/stacktrace/): dense forensic data made
  readable, the frame as the unit.
- [Prisma Studio](https://www.prisma.io/studio): the nearest genre match, a local
  single-purpose inspector launched from a CLI.
- Datasette: deliberately plain, table-first, unembarrassed. A corrective when the design
  starts reaching for decoration.
- Linear: restraint and calm density. Study the discipline, not the palette.
- `delta`, the git diff pager: alignment and restraint in diff rendering.

Study each for one decision. Copying any wholesale substitutes another product's identity for
ours.
