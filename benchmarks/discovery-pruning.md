# Discovery pruning (#209)

The number that justified skipping excluded directories rather than walking into them and
deciding per file.

## Fixture

20 documents, plus a `node_modules` of 400 packages holding 25 files each: **10,000 files
nobody chose**, excluded by the built-in defaults. Measured 2026-08-05, Linux, Node 24.18.1,
median of three runs after a warm-up.

| | median |
|---|---|
| Before: walk everything, decide per file | **188 ms** |
| After: prune the excluded directory | **3 ms** |

Roughly **63x**, and the gap grows with the dependency tree. A real `node_modules` is often
200,000 files rather than 10,000.

It is not a one-off cost. Discovery runs on every `lore build`, every `lore plan`, every
`lore status`, and on every watcher reconcile sweep, which is every two seconds by default.

## Reproducing

The harness is a few lines against `discover()` and is not kept as a file, because the useful
part is the comparison and the "before" no longer exists. To repeat it: build a fixture of the
shape above, time `discover({ config })`, then replace the `matcher.decideDirectory(canonical)`
call in `packages/compiler/src/discover/discover.ts` with `null` and time it again.

## What was not changed

The matching semantics. `drafts/**` names the *contents* of a directory and does not prune it,
so a negation like `!drafts/keep.md` still works; `drafts/` names the directory and does prune,
and gitignore says a negation cannot reach inside one. Following git is what keeps the walking
layer and the matching layer from disagreeing, which is the divergence #209 was opened to
resolve.
