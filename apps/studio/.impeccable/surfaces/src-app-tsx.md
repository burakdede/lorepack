---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Lore Studio surface brief

Scope: the whole Studio app (shell plus six routes). Mode: Operate.
Audience: developers running `lore dev`, moving between terminal and browser.
Job: inspect one immutable build: what was compiled, what was left out, what a model receives, which versions exist, whether the environment is healthy.
Constraints: offline, no new dependencies, routes and API unchanged, provenance on every item, explicit confirmations for version actions, keyboard and reduced motion preserved.
Memorable moment: the budget tape in Playground and the command palette that jumps to any source or table.

## Direction contract

THESIS: Studio is a first-class developer inspector, the kind of tool that sits beside DevTools and Linear without apology. It refuses the poster-like route page (giant title, decorative zones, inverted header) in favour of a persistent sidebar, a quiet page header, and list/detail panes where the evidence is the content.

OWN-WORLD: Restrained neutral zinc in two peer themes; a second, slightly cooler neutral layer for the sidebar; no accent hue: selection, focus and the primary action are carried by ink contrast (near-black on light, near-white on dark), as the contrast test requires; green, amber and red only for state, always beside a word. 1px hairline borders, 8px control radius, 12px panel radius, soft offset shadows only on overlays. IBM Plex Sans for UI, IBM Plex Mono for ids, paths, SQL and numbers. Authored 16px line icons at 1.5 stroke.

STORY: A developer lands on Overview and in one glance knows which build is live, whether sources are fresh, and what to do next. They drill into a source, run a task in Playground and see exactly what fit the budget and what fell off, compare two builds, and activate one with a confirmation that names the build.

FIRST VIEWPORT: 248px sidebar left (project name, active build id with copy, freshness pill, six nav items with icons, search trigger showing the Cmd-K hint, theme switch pinned bottom). Right: 56px page header (title, one-line description, route actions right). Overview body: a full-width build summary panel (build id large mono, created time, compiler, capabilities as chips) above a two-column grid: contents facts left, source state and next-build plan right.

FORM: Developer Inspector, list position 1 of 7 (IMPECCABLE'S PICK, chosen by the user over the assigned roll), seed key df0e331e. Signature interaction: Cmd-K command palette with fuzzy jump to routes, sources and tables. Motion grammar: 150 to 200ms ease-out for hover, pane and palette reveal; the build id settles when a rebuild lands; nothing else moves.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
