# Lore Studio design direction

## Direction

Lore Studio is a build atlas for developers. It should feel like a precise
field guide to one immutable context build, not a marketing dashboard or a
generic admin template.

The visual world uses a warm paper ground, dark ink, and flat color zones. The
zones are functional: they identify the active build, source terrain, context
playground, structured tables, version history, and diagnostics. Organic panel
corners and broad territory blocks borrow the shape language of a map without
turning the interface into an illustration.

## Product truths

- The active build is the source of truth.
- Every result and table row keeps its provenance visible.
- The interface is read-mostly and local-first.
- Dense developer information needs hierarchy, not decoration.
- Status colors communicate state only. They do not imply authority or truth.

## System

### Color

- Paper: `#f7f1e6`
- Surface: `#fffdf7`
- Ink: `#20231f`
- Muted ink: `#6c7067`
- Rule: `#d8d2c4`
- Sage zone: `#d9e8c8`
- Coral zone: `#f2c7b9`
- Gold zone: `#f3dfa1`
- Blue zone: `#c8deea`
- Lilac zone: `#d9d0e8`

State colors remain semantic and are paired with text and shape, never used as
the only signal.

### Typography

IBM Plex Sans carries headings and prose. IBM Plex Mono carries paths, hashes,
commands, IDs, values, and dense tabular data. Headings are compact and direct.
Labels use uppercase tracking sparingly for orientation and section markers.

### Shape and layout

- Use flat surfaces and rules instead of a stack of floating cards.
- Use a small radius for controls and irregularly rounded territory panels for
  route-level emphasis.
- Keep a wide desktop reading frame and let dense content scroll horizontally
  on narrow screens.
- Treat the header and route rail as a persistent field instrument.
- Use a single strong route title, a short explanation, then the evidence.

### Motion

Motion is limited to route transitions, focus movement, and a short status
settle when the active build changes. Reduced motion removes transforms and
transition timing while preserving state changes.

## Route map

- Overview: active build territory and the quickest orientation point.
- Sources: source terrain, inclusion state, and provenance.
- Playground: context output with citation landmarks.
- Tables: structured data with sheet and range context.
- Versions: immutable build history and activation state.
- Diagnostics: validation and runtime signals.

Each route keeps its existing data model, API behavior, keyboard affordances,
and explicit loading, empty, and failure states.

## Anti-brief

Do not add gradients, glass effects, decorative charts, fake metrics, generic
dashboard stat tiles, unlabelled icon buttons, or imagery that competes with
the build evidence. Do not flatten structured source content into prose.

## Quality bar

The redesign is complete when all six routes have a coherent atlas language,
the narrow layout remains usable, dark mode and reduced motion remain legible,
the existing browser tests pass, and the README shows current Studio captures.
