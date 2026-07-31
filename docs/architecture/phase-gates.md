# Phase gates

Each delivery phase states its acceptance criteria in its epic issue, for humans. This is
the executable mirror: one command that answers "is this phase still satisfied?" on any
machine, at any time.

```bash
pnpm phase:check 0          # human-readable report
pnpm phase:check 0 --json   # machine-readable
```

## Why

The project has twice shipped a rule that existed only as documentation and was therefore
not a rule. `schemas:check` lived in the `verify` script but not in the CI workflow, so a
drifting schema would have merged with CI green. The em dash ban was prose until a script
enforced it.

Phase acceptance had the same shape. Three of Phase 0's criteria were genuinely
machine-checked; the rest were a markdown checkbox and a paragraph written once. Deleting
`packages/core/src/ports/storage.ts` would not have failed anything until some later phase
tried to import it.

A gate turns each promise into an assertion that fails the build that breaks it, rather
than a discovery made three phases later.

## Criterion kinds

Deliberately few. Adding a kind should be rare and considered.

| Kind | Checks | Fails when |
|---|---|---|
| `command` | A script exits zero | Non-zero exit; the tail of its output is reported |
| `exports` | A built package still exports named symbols | A symbol is gone, or the module cannot be imported |
| `path` | Files or directories exist | Any is missing, and it is named |
| `issues` | Every issue in a milestone is closed | An unexpected issue is open, and it is named |

## Unverified is not a pass

The `issues` kind needs network access and GitHub authentication. When either is missing it
reports **`unverified`**, never `passed`, and says why.

This is the point of the design. A gate that succeeds because it could not check is worse
than no gate: it converts an unknown into a false assurance. Exit codes keep the three
outcomes distinct:

| Exit | Meaning | Reaction |
|---:|---|---|
| 0 | Every criterion passed | Nothing |
| 1 | Something failed | A guarantee is broken; fix it |
| 2 | Nothing failed, something could not be checked | The gate has a gap; close it |

## Where it runs

`.github/workflows/phase-gates.yml` runs on pushes to `main`, not on pull requests. A gate
answers a question about the trunk. On a pull request the issue-closure criterion would
fail for the very issue being merged, which is a paradox rather than a signal.

It can also be run manually with `workflow_dispatch` against any phase.

## Adding a phase

1. Write `tools/phase-gate/src/phases/phase-N.ts`, one criterion per promise the epic
   makes: its exit criteria, its stated deliverable, and each capability it claims.
2. Register it in `tools/phase-gate/src/registry.ts`.
3. Add an id to the coverage test, which asserts every expected criterion is present so a
   promise cannot be quietly dropped from the definition.

Write each `promise` in the phase's own words. A failing gate should read as a broken
guarantee ("Activation is a transactional pointer change") rather than as a broken
assertion ("expected 3 to be 3").

A phase with no definition reports `unverified` and exits 2, rather than being treated as
satisfied.

## What a gate is not

It does not replace the epic issue, the handoff comments, or the tests. It composes
existing checks and asserts the public surface still exists. A criterion that needs new
test coverage should get a test; the gate then runs it.
