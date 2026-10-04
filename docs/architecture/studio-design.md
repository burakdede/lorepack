# Studio design

Lore Studio is a build atlas for developers. It makes one immutable context
build legible without turning the product into a generic dashboard.

## Direction

The interface uses a warm paper ground, dark ink, and flat color territories.
Each territory identifies a functional surface: the active build, source
terrain, context playground, structured tables, version history, or
diagnostics. Organic corners and broad zones borrow the shape language of a
map while keeping the evidence itself dense and factual.

The full direction contract lives in [`DESIGN.md`](../../DESIGN.md), with the
machine-readable tokens in [`.impeccable/design.json`](../../.impeccable/design.json).

## Product truths

- The build is the source of truth.
- Provenance stays visible on results, context items, and table rows.
- Studio is local-first and read-mostly.
- Status colors communicate state only. They do not claim authority or truth.
- Existing API behavior, keyboard affordances, and explicit loading, empty,
  and failure states remain part of the design.

## Typography

IBM Plex Sans carries headings and prose. IBM Plex Mono carries paths, hashes,
commands, IDs, values, and dense tabular data. Numeric columns use tabular
figures so a large build remains scannable.

## Tokens

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#F7F1E6` | `#171916` |
| `--surface` | `#FFFDF7` | `#20251F` |
| `--text` | `#20231F` | `#EDEAE3` |
| `--text-muted` | `#696D66` | `#918B81` |
| `--border` | `#D1C7B6` | `#465043` |
| `--zone-sage` | `#D9E8C8` | `#31442E` |
| `--zone-coral` | `#F2C7B9` | `#4C3029` |
| `--zone-gold` | `#F3DFA1` | `#4A3E1E` |
| `--zone-blue` | `#C8DEEA` | `#263D48` |
| `--zone-lilac` | `#D9D0E8` | `#3D344C` |

Controls use a 6px radius. Route-level territory panels use an irregular
radius to create a map-like edge without shadows or gradients.

## Route map

| Route | Surface role |
|---|---|
| Overview | Active build territory and orientation point |
| Sources | Indexed and excluded source terrain |
| Playground | Model context, citations, and omissions |
| Tables | Structured data, schema, and read-only SQL |
| Versions | Immutable history, activation, and comparison |
| Diagnostics | Validation and runtime signals |

## Motion and accessibility

Motion is limited to the active build settling in the header, focus movement,
and ordinary control feedback. Reduced motion removes transforms and timing.
The route rail remains keyboard reachable, wide tables scroll inside their own
box, and state labels pair text with color and shape.

## Anti-brief

Do not add gradients, glass effects, decorative charts, fake metrics, generic
dashboard tiles, unlabelled icon buttons, or imagery that competes with build
evidence. Do not flatten structured source content into prose.
