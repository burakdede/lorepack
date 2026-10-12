# Retained validation verification

Verified on 2026-10-12 with the built Lorepack CLI0.1.0, Node24.21.0, macOS arm64.
Native Linux/Windows qualification remains required in CI.

The real CLI fixture builds sealed A from Markdown and CSV. Its sources then change
or disappear. Both JSON and human `validate --build <A>` verify A without discovery
or parsing. Human output identifies the full selected ID and says that sources,
stored build data and the active pointer were not changed. File SHA snapshots and
the active tuple are identical before and after verification. The
[candidate regression](../../packages/cli/test/candidate_validation.test.ts) corrupts
real SQLite mappings and coordinates after writing the candidate and verifies that
neither sealing nor activation can occur.

Corrupt retained node/chunk/table line ranges while B is active. Exact-A validation
refuses with `LORE_E_OBJECT_CORRUPT` naming `locator-ranges`, leaves B active and
changes no stored file. Missing identity inputs return `LORE_E_SCHEMA_MISMATCH`;
missing objects and wrong table counts refuse without repair. Invalid IDs, absent
storage and compile flags accompanying `--build` fail without initializing storage.
The shared identifier validator uses `LORE_E_BUILD_NOT_FOUND` for malformed IDs.

The clean npm install proves the verifier child is shipped: import a packed build,
delete its producer, validate the exact imported ID, activate it, search and query
its table. The installed production dependency tree is checked against the lockfile,
PDF parsing loads no native add-on and npm audit reports no vulnerabilities.

The [memory regression](../../packages/cli/test/selected_validation.test.ts) uses a real
corrupted normalized object of128 MiB is verified in a fresh child process.
Streaming validation refuses its checksum with less than128 MiB RSS growth; the
old body-materializing path fails that same bound. This is a memory regression
oracle on the fixture, not a general portable performance promise. Streaming hash
cancellation is tested with a real file and AbortSignal.

Reproduce with:

```bash
pnpm build
pnpm exec vitest run --project cli packages/cli/test/selected_validation.test.ts
pnpm exec vitest run --project compiler packages/compiler/test/validate.test.ts
pnpm exec vitest run --project backend-local packages/backend-local/test/tables.test.ts
pnpm exec vitest run --project core packages/core/test/hash.test.ts
pnpm check:packed-cli
```
