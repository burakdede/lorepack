# Retrieval and ranking

How a query becomes a page of results, and why it is the same page every time.

Architecture section 13.2 fixes the order: FTS5 candidates, exact-match boosts, status
adjustment, authority, superseded suppression, filters, expansion, near-duplicate removal,
diversity, then budget-aware packing. Steps 1 to 9 are search. Step 10 belongs to context
assembly.

## Where each part lives, and why

| Part | Package | Why there |
|---|---|---|
| BM25 candidates, filters | `backend-local` | Only a backend knows SQL. A Worker over D1 will have its own |
| Weights | `core` | Two things need them and neither may import the other |
| Steps 2 to 9 | `runtime` | Ranking is portable, so it must not need a database to run |

**Ranking weights are never stored in a build.** Architecture 12.9: baking them into the
index would make retuning ranking a rebuild, and would make two builds of the same sources
disagree because differently tuned compilers produced them. `RANKING_WEIGHTS` in
`@lorepack/core` is the one table, versioned by `RANKING_WEIGHTS_VERSION` so a benchmark
can say which tuning it measured.

## The score is a heuristic, not a verdict

A score says how well a chunk matches the words that were asked for. It is not a
confidence, and it is not evidence the content is correct. `authority` is a number the user
wrote in their configuration; it breaks a tie and it never decides which of two documents is
true (invariant 6). `lore search --debug` prints the components and says so in the output.

## Why BM25 is bounded before anything is added to it

Raw BM25 is not comparable across corpora, and the gap is not small. Measured on this
project:

| Corpus | Query | Raw BM25 |
|---|---|---|
| 500 documents, every one repeating the same words | `rollback deployment` | 0.000002 |
| 400 documents of varied prose | `kubernetes` | 5.43 |

A term that appears everywhere carries no information, so BM25 collapses toward zero. Add a
fixed boost of 3 to both and the boost is invisible in one corpus and decisive in the
other: the weights become untunable and the debug output unreadable.

So the lexical component is `raw / (raw + saturation)`, which maps `[0, infinity)` onto
`[0, 1)`. Saturating, so a spectacular lexical match cannot drown every other signal.
Monotone, so a better match never ranks lower for being scaled. Exactly `0.5` at the
saturation constant, which is what makes that constant readable. `scoreComponents` reports
both the bounded value and `lexicalRaw`, for anyone comparing against another engine.

The boosts are then sized to **decide a close contest rather than win any contest**. A
document titled for the query beats a comparable match, because that is what a person means
by typing a name. It loses to a section that covers the subject in depth, because a title is
a label and the deeper match is more likely to be the answer. Both cases are asserted.

## Determinism

The same build and the same query produce the same page, byte for byte. Three things make
that true:

1. **No clock, no randomness, no database** in the ranking code. It is pure functions over
   plain data.
2. **A total tie-break**: score, then canonical path, then chunk id. Two chunks with equal
   scores cannot swap places between runs or between machines.
3. **Fixed precision**: scores are rounded before comparison, so a floating-point tail
   cannot reorder a page.

## Candidate depth

Ranking can only reorder what it was given. A page of ten taken straight from BM25 would
make every boost decorative, so the index is asked for `max(60, limit * 8)` candidates,
capped at 500.

## Near-duplicates and diversity

Duplicate removal uses word shingles and Jaccard overlap: a deterministic signature, not an
embedding. An embedding would mean a model download, which breaks the zero-surprise install
(invariant 7), and would make the page depend on a model version.

One artifact may contribute at most three chunks to a page. A long document that mentions
the query in every section would otherwise be the entire answer.

## Status, authority and supersession

Architecture 12.7, applied at query time:

- **archived**: excluded by default, included on request, and surfaced as a fallback when
  nothing active matched at all. Always labelled.
- **draft**: ranked lower and labelled.
- **superseded**: suppressed from default results, still readable on request, labelled.
- **authority**: a multiplier between 0.75 and 1.25, centred on 1 at the default of 50. The
  range is deliberately narrow. If authority could dominate the lexical signal it would
  function as a truth claim.

Note the boundary this phase actually reaches: the compiler does not yet apply configuration
rules, so every artifact in a Phase 2 build is `active` with authority 50. Rule resolution is
#78 in Phase 5. The ranking behaviour above is unit-tested against synthetic candidates now,
and becomes reachable end to end when rules land.

## Filters narrow the candidates, never the ranking

Every filter is applied in SQL, before scoring, so a filtered search is a search of a
smaller corpus rather than a filtered page of results. That matters when a filter is
narrow: filtering after ranking would return whatever survived the top 10, which for a
one-document filter is usually nothing.

| Filter | Matches |
|---|---|
| `pathGlob` | canonical path against a glob |
| `fileType` | file extension, without the dot |
| `status` | one or more declared statuses |
| `artifactId` | exactly one document, by artifact id **or** by canonical path |

`artifactId` is exact on both forms and never widens to a prefix. A caller holds whichever
form the previous answer gave it (the locator carries both), and asking for a document that
does not exist returns nothing rather than the document it nearly names. The CLI spells it
`lore search "rollback" --source guides/deployment.md`.

## Assembly: the same path, packed to a budget

`contextForTask` reuses this pipeline and then packs (architecture 13.3). Two differences
worth knowing:

- **A task is a sentence, not a keyword.** No chunk contains every word of "how do I roll
  back a release", so an all-terms index query returns nothing at all, which is what the
  first implementation of assembly did on every task it was given. Candidates are therefore
  fetched with all terms first and, only if that finds nothing, with any of them. Two fixed
  steps, so the same query still produces the same candidates.
- **A budget outside 4,000 to 40,000 has to be asked for twice.** Every profile default
  sits inside that range. Below the floor a bundle is too small to orient a model and still
  say anything; above the ceiling it stops being bounded context. Both are permitted, and
  neither happens by typo: an out-of-range budget is refused unless the caller also passes
  `allowUnsupportedBudget` (`--allow-unsupported-budget` on `lore export`).
- **The omission report has to be complete.** Search shows a page and need not explain what
  fell off the end; assembly must. `rankWithReport` returns what it dropped and why, so a
  near-duplicate removed before packing is still nameable. Without it the report would have
  been a partial account dressed as a complete one.

## Measured cost

Provisional, on the development machine, since the reference machine is #101:

| Corpus | Warm search p95 | Bundle p95 | Gates |
|---|---|---|---|
| 3,200 chunks | 6.59 ms | 60.4 ms | 250 ms, 1,500 ms |
| 50,000 chunks, the stated envelope | 21.45 ms | 199.96 ms | 250 ms, 1,500 ms |

`pnpm bench:retrieval` reproduces them; the recorded runs are in `benchmarks/retrieval/`.
Reported, never enforced, until #101 defines the machine.

### One optimisation worth knowing about

Near-duplicate detection dominated assembly: 37 ms of a 45 ms bundle at 216 candidates, and
it grows with the square of the candidate cap. It now stops as soon as the answer is
settled. Jaccard overlap reaching a threshold implies a minimum number of shared shingles,
so once enough elements have missed, the rest of the set does not need examining. Most pairs
are not near-duplicates and most of those settle after a handful of misses.

The early exit is exact, not an approximation, and a property test compares it against the
plain computation over 1,500 generated pairs at three thresholds rather than trusting the
algebra. Bundle p95 fell from 194.59 ms to 60.4 ms.
