# Pattern admission verification

Issue #590 is existing work in progress, retained under the owner's instruction
to finish active tasks while keeping new intake limited to v0.1.0 release blockers.

## Regression evidence

The unmodified main 271a22f0 baseline failed 13 rejection cases while two admitted
pattern controls passed. The first correction passed all 15. Additional portable
separator and escape-budget controls plus actual CLI cases passed all 20 tests
on 16 October 2026, macOS arm64, Node 24.21.0, Vitest 4.1.11.

The first CLI test incorrectly expected exit code 2, which belongs to a different
error category. All three commands actually returned the correct typed
configuration error with exit code 1. The test now asserts that existing contract;
no product guard or existing assertion was changed. Failed receipts are retained.

The tests cover exact admission limits, repeated-star rejection before matching,
source line/field diagnostics, direct API calls and unmatched supersession rules.
The actual binary exercises plan/build/dev refusals for ignore/match/supersedes
inputs, then checks the selected build ID, manifest bytes and build inventory.
After correcting the input, search returns the original cited document from that
same build. Invalid ignore input also permits direct retained-build inspection.

```sh
pnpm build
pnpm exec vitest run packages/core/test/pattern_limits.test.ts packages/compiler/test/pattern_limits.test.ts packages/cli/test/pattern_limits.e2e.test.ts
```

## Manual checklist

- Start from a disposable Markdown project and run `lorepack build --json`.
- Put the repeated-star fixture from the compiler test on line 3 of `.loreignore`.
- Run plan/build/dev with `--json`; require exit 1 and LORE_E_CONFIG_INVALID naming line 3.
- Inspect the retained build and confirm the selected ID did not change.
- Restore a valid ignore file, declare the pattern in match and then supersedes,
  and require a typed error naming the corresponding YAML field.
- Restore configuration and search for the original marker; check the same build
  and its line locator. No activation or compilation should occur during that read.

Full current integration, manual observation and native Linux/macOS/Windows proof
remain required before issue closure. No new platform skip is introduced.

The broader core/compiler/init/public-CLI cohort then passed all 883 cases across
29 files, with strict types for all three changed test files. The separate actual
user check passed five binary commands: a readable line-3 refusal, retained-build
inspection, a typed supersedes-field refusal, and restored search returning the
original line-3 locator and build ID. Selected manifest bytes were unchanged.
These are local scoped results, not full current or native qualification.
