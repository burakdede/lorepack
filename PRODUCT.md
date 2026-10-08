# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and AI-tool builders who run `lorepack dev` locally while inspecting the context build an AI depends on.

## Product Purpose

Lorepack compiles project documents and artifacts into immutable, inspectable builds. Lorepack Studio is the local browser inspector for one running build: it helps a developer understand what was compiled, what was excluded, what a model would receive, which versions exist, and why the local environment is healthy.

## Positioning

The build is the source of truth. Studio makes that immutable build legible while preserving provenance, structure, build identity, freshness, and the distinction between user-declared metadata and detected truth.

## Operating Context

Studio is served by the same local `lorepack dev` process that provides the API and MCP surface. Users arrive from a terminal workflow, usually after building or watching a project, and move between terminal output and the browser. The interface must work offline, without an account or hosted service, and must remain useful at dense artifact and table sizes.

## Capabilities and Constraints

- Overview shows the active build, source freshness, counts, capabilities, warnings, and rebuild planning.
- Sources shows indexed artifacts and exclusions with reasons and provenance.
- Playground assembles bounded context and exposes selections, omissions, ranking heuristics, and citations.
- Tables exposes typed schemas, sample rows, provenance, and a read-only bounded SQL console when tables exist.
- Versions shows immutable build history, diffs, activation, rollback, and packing behind explicit confirmations.
- Diagnostics shows doctor checks, the running session, environment details, watcher state, and client status.
- Studio is read-mostly. Only explicitly confirmed version actions mutate local state.
- Every result, context item, and table row must retain a `SourceLocator`.
- The redesign must preserve existing routes, API contracts, keyboard access, reduced-motion behavior, local-only boundaries, and developer terminology.

## Brand Commitments

The product name is Lorepack. The voice is precise, calm, direct, and developer-centric. The UI should feel like a trustworthy instrument for inspecting build artifacts, not a marketing dashboard.

## Evidence on Hand

- Existing Studio implementation in `apps/studio`.
- Existing behavior and accessibility tests in `apps/studio/test`.
- Real-browser coverage in `tools/studio-e2e`.
- Current visual and behavioral guidance in `docs/architecture/studio-design.md` and `docs/architecture/studio.md`.
- README and architecture screenshots generated from real builds under `docs/images`.
- No user-provided brand assets or external imagery. Do not invent product claims or customer proof.

## Product Principles

- Make the immutable build legible before adding decoration.
- Preserve provenance and structure at the point of use.
- Prefer explicit actions and honest states over inferred status.
- Keep density high enough for developer workflows and hierarchy strong enough for scanning.
- Read-only boundaries and accessibility are product behavior, not polish.

## Accessibility & Inclusion

Studio must remain keyboard navigable, preserve visible focus, meet the existing contrast checks in light and dark themes, work at 200% zoom without page-level horizontal overflow, and honor `prefers-reduced-motion`. Screen-reader announcements and reduced-motion behavior remain manual release checks.
