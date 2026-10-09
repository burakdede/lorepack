# Issue 510 implementation plan

## Outcome

Make the README a practical product tour and make the benchmark evidence executable from a clean checkout.

## Critical path

1. Expose benchmark scale and edge-case selection through the existing corpus runner.
2. Add a real-browser Studio capture script that produces the three documented workflow GIFs.
3. Link the commands, use cases, static alternatives, and benchmark interpretation from the README.
4. Regenerate media, run visual and repository checks, then close #510 after the PR is merged.

## Parallel work

- README use-case writing can proceed after the command and media names are fixed.
- Studio GIF capture can proceed independently of benchmark implementation.
- Benchmark guide updates can proceed independently of GIF capture.

## Verification

- Run the selectable benchmark at one scale and each edge-case profile.
- Inspect the generated GIFs and static screenshots at the README viewport.
- Run documentation image/link checks, formatter, lint, typecheck, architecture tests, and the focused benchmark tests.
- Run the full CI workflow before enabling auto-merge.

## Boundaries

The benchmark remains an engineering evidence tool. Repeated corpus packs are labelled as scale trends, offline RAG remains retrieval-only, and GIFs are generated from the real CLI and Studio rather than synthetic mock output.
