# Legacy CSV table-evidence fixture

The sealed `csv_evidence_legacy.lorepack` was produced by the qualified #596 CLI
`39f9cf3d544f919de3164b8c57a874942d03e8a0`. Its parser is `0.1.1`, build-identity
normalization is `2`, and parser-local table normalization is `1`. It has no
`tableEvidence`. The new evidence uses CSV parser `0.1.2`.

The [provenance receipt](csv_evidence_legacy.provenance.json) records the actual producer
tar hash, source bytes, commands, descriptions, pack verification and archive hash. It
embeds the exact executed recipe and its hash, so formatting the current generator does
not rewrite historical evidence. `csv_evidence_legacy_inputs.json` supplies the same
config and CSV bytes to generation and upgrade testing. Existing outputs are never overwritten.

## Verify the upgrade

```sh
pnpm build
pnpm exec vitest run packages/cli/test/csv_evidence_identity.e2e.test.ts
```

The real CLI imports and activates the old archive, reads unknown formula markers and
unrecorded warnings, rebuilds identical inputs, and checks known absence with unchanged
rows, locators and old-build bytes. The test asserts the CSV-specific parser version,
because changing an unrelated parser also changes the overall build ID. CLI inspection
returns its build ID outside the stored table description; HTTP/MCP response envelopes
are not fabricated for this CLI test.

## Regenerate only from the recorded producer

Use Node `24.21.0` (SQLite `3.53.4`), npm `11.19.0` and pnpm `11.18.0` on POSIX.
The retained producer tar must hash to
`ee0a1c47b42c47e858a1aca1e83a0d2d02ff57b29e33ae4502ee0d51befbbdc2`.
Run in an empty fixture destination, preserving existing qualified fixtures first:

```sh
node fixtures/builds/generate_csv_evidence_legacy.mjs /path/to/qualified-596-cli.tgz
```

Generation installs the local bundled tar offline with scripts disabled and drives its
actual build, inspect and pack commands. Review the new receipt before replacing a fixture.
Tests import the committed archive without downloading an old package.
