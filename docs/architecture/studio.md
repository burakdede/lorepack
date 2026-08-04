# Studio

The inspector. Five routes, served by the same process that serves the API, on the same port,
from static files that were built into the CLI package.

The visual direction, the token values and the anti-brief are in
[studio-design.md](./studio-design.md). This page is about behaviour: what is verified
automatically, what a person still has to check by hand, and how to run either.

## What Studio is for

| Route | The question it answers |
|---|---|
| Overview | What is in this build, and have the sources moved on since it was made? |
| Sources | Exactly what was parsed, and exactly what was not, and why. |
| Playground | What would a model actually receive for this task, and what was left out? |
| Versions | What changed between two builds, and which one is live? |
| Diagnostics | Why is this not working, and what do I run to fix it? |

It is read-mostly. The only actions that change anything are on Versions (activate, roll back,
pack), they exist only on `lore dev`, and they refuse any browser origin that is not a loopback
literal. See [serving.md](./serving.md#the-write-surface).

## Running it

```bash
lore dev                      # Studio, the API and MCP on one port
pnpm --filter @lorepack/studio dev   # Vite with hot reload, proxying to a running `lore dev`
```

## What is verified automatically

| Suite | Command | What it covers |
|---|---|---|
| Component | `pnpm vitest run --project studio` | Route behaviour and the wording invariants, against a mocked API |
| Contrast | `pnpm vitest run --project studio contrast` | WCAG AA for every documented token pair, in both themes |
| Browser | `pnpm test:e2e` | The assembled app against a real `lore dev`: axe, keyboard, 1280x720 and 200% zoom |

The browser suite needs Chromium once:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

It builds a fixture project, runs two builds so there is a history to compare, starts a real
server and drives Chromium against it. Nothing is mocked, which is the point: the component
tests cannot catch a route asking for a field the server does not send, an asset path that
404s once bundled, or a page that scrolls sideways at the documented viewport.

axe runs on every route and fails on any violation of `critical` or `serious` impact.

## The manual keyboard pass

Automation covers reachability, focus visibility and the axe rule set. It cannot tell you
whether the order makes sense, whether the announcements are useful, or whether the thing you
land on is the thing you expected. Run this before a release, with the mouse unplugged.

Record the date, the browser version and the screen reader version alongside the result.

1. **Skip link.** Load Overview. Press Tab once. The first stop is "Skip to content", it is
   visible, and Enter moves focus into the main region rather than merely scrolling.
2. **Navigation.** Tab through the five links. Each shows a focus ring against the header.
   Enter follows. The build id in the header does not move or reflow as routes change.
3. **Overview.** Tab reaches the copy button on the build id and the "Plan a rebuild" button.
   The plan is never fetched until that button is pressed.
4. **Sources.** Tab reaches the indexed/excluded switch, the filter, and every file in the
   table. Enter on a file opens the detail beside it; focus stays where it was pressed.
   Switching to excluded and back does not lose the filter. On the excluded view, both
   tables are present: what a rule removed, and what the walk read and could not parse. The
   number on the switch is the sum of the two.
5. **Playground.** Tab reaches the two tabs, the task field, profile, budget, and Assemble.
   A budget outside the documented range disables Assemble and says the range. After
   assembling, every omission is on screen without expanding anything.
6. **Versions.** Tab reaches Compare, Activate and Pack on each row, then Roll back, then the
   two comparison selects. Pressing Activate moves focus to the confirmation heading. Escape
   closes it from anywhere inside and sends nothing. The confirm button names the build.
7. **Diagnostics.** Tab reaches "Re-run checks". Every remediation is selectable text that can
   be copied whole, without truncation.
8. **Announcements.** With a screen reader running, activate a build from Versions. The header
   announces the new build id and source state once, not on every poll.
9. **Zoom.** At 200% on a 1280x720 screen, walk all five routes. Nothing scrolls horizontally.
   Wide tables scroll inside their own box, and the navigation stays reachable.
10. **Reduced motion.** With the system preference set, the header crossfade does not animate
    and nothing else moves.

## The design review

Run alongside the keyboard pass, against the anti-brief in
[studio-design.md](./studio-design.md). The list there is the checklist; the questions worth
asking each time are:

- Does any number on screen read as a score, a grade or a confidence? (Section 4.5 and 13.4.)
- Is any state carried by colour alone, without a word beside it?
- Has anything acquired a card, a tile, a gradient, a shadow or a chart?
- Does any route claim Lorepack detected a conflict or decided which document is right?
  (Invariant 6.)
- Would a person who reads only the buttons know what each one is about to do, and to which
  build?

### Recorded passes

| Date | Verified by | Browser | Result |
|---|---|---|---|
| 2026-08-04 | Phase 4 build session | Chromium 151.0.7922.34 | Automated suites green: axe clean on all five routes, keyboard reachable, no horizontal scroll at 1280x720 or 200% zoom, WCAG AA on every documented token pair in both themes. The manual steps above (screen reader announcements, reduced motion) are not yet signed off by a person and are due before v0.1. |

### Design review, 2026-08-04, against the anti-brief

Run before Phase 4 closed, as the epic requires. Each line of the anti-brief in
[studio-design.md](./studio-design.md), checked against what shipped:

| Anti-brief item | Result |
|---|---|
| component-library look, default radii and shadows | No component library. `box-shadow` appears nowhere; the only radius is `--radius: 3px`, plus a 1px inset on the focus ring |
| Inter, or a violet/indigo accent | IBM Plex Mono and Sans. No accent colour exists: the token set has three state scales and an idle alias, and a test fails if an `accent` token appears |
| a card grid on any route | No cards. Overview and Diagnostics use aligned key-value blocks; Sources, Versions and the omissions list use tables |
| stat tiles, delta arrows, trend lines | None. The counts are a `<dl>`, because these are facts about one immutable build and there is no delta to show |
| donut charts, sparklines, gauges, health scores | None. Asserted: the Playground and Diagnostics tests fail on any `<svg>`, `<meter>`, `<progress>` or percentage |
| gradients, glassmorphism, `rounded-2xl` | None present |
| emoji or sparkle characters | None. The interface is text and three state colours |
| a marketing-style hero on Overview | The first element is the source state, which is the only thing on the route that moves under the reader |
| skeleton shimmer loaders | None. `Loading` is a line of text with `role="status"` |

Questions asked alongside it:

- **Does any number read as a score?** No. The relevance breakdown is a definition list behind
  a `<details>`, captioned as a ranking heuristic, and `lexicalRaw` is withheld because raw
  BM25 is not comparable across corpora.
- **Is any state carried by colour alone?** No. Every badge shows the word, the diff carries
  `+ ~ -` markers, and the active build is marked with the word "active".
- **Does any route claim a conflict was detected?** No, and the Playground test fails on the
  words "conflict", "outdated" and "incorrect" appearing anywhere on the page.
- **Would a person reading only the buttons know what happens?** Yes on Versions, where every
  confirm button reads `Activate lore_4e13844420af` rather than `Confirm`.
