# CSV allocation bounds

Issue [#596](https://github.com/burakdede/lorepack/issues/596) found that the CSV
row/column checks ran after the complete grid had been allocated. Over-limit files could
exhaust the parser heap instead of returning their typed CSV warning.

## Reproduce

```bash
pnpm build
pnpm exec vitest run packages/parsers/test/csv_limits.test.ts packages/parsers/test/csv.test.ts packages/parsers/test/isolation.test.ts packages/cli/test/parse-limits.test.ts
```

`csv_limits.test.ts` runs the compiled parser in a fresh child per input with a 256 MiB
V8 heap and a fixed 512 MiB native peak RSS ceiling. These are diagnostic controls, not
changes to the default production heap. Each child must return the correct typed warning,
no table, intact artifact hash/size and source locators. A refused description must not
claim a total row count. The test prints complete JSON input and measurement records.
`process.resourceUsage().maxRSS` reports native peak KiB; the test converts it to bytes.
It never substitutes a final RSS sample for the peak.

The audit supplied shapes and approximate sizes rather than original fixture bytes.
These exact generated inputs make the regression reproducible:

| Input | Bytes and shape | SHA256 |
|---|---|---|
| rows.csv | 67,108,864 bytes, repeated `a\n` | `a1d18a09d8a805cfac1977e587848bd7c7bef5e0d23844f5d7895378f14efbab` |
| cols.csv | 67,108,864 bytes, `a` followed by commas | `9375bf5e9e421d5088e1b8c0c61dfe01cc85fce04303b113fd713b27c36fb344` |
| rows8.csv | 8,388,608 bytes, repeated `a\n` | `7c9d264c131b73500535e778f93fe8ae313bca03308152934ebc7851f3b3ece2` |

## Measured evidence

On 2026-10-17, macOS arm64, Node 24.21.0, all three baseline children aborted at their
unchanged 256 MiB heap before the correction. The bounded parser returned typed refusals
with these native peaks in the expanded regression run:

| Input | Peak RSS bytes | Warning |
|---|---:|---|
| rows.csv | 510,246,912 | csv-too-many-rows |
| cols.csv | 280,313,856 | csv-too-many-columns |
| rows8.csv | 322,682,880 | csv-too-many-rows |

The ceiling is 536,870,912 bytes. These receipts establish one measured local run, not a
portable memory promise. Linux and Windows qualification remains required in native CI.
The raw JSON records and genuine baseline failures are retained in
`lorepack_release_evidence/parser_limits/596_csv/` beside the repository. Later native
measurements appear in their test-job logs; keep each outcome rather than replacing it
with a best result.

## Protection and compatibility

`csv.test.ts` retains the original accepted 500,000-row envelope and dialect/value/locator
assertions, with exact no-header and 100-column boundaries and refusal before a malformed
unread tail. Golden fixtures change only the CSV parser revision to `0.1.1`.

The original isolation and CLI memory cases keep their input, 128 MiB heap, deadlines,
case names and final memory/activation assertions. Their original single-column CSV now
returns a typed row refusal first. Each case then parses an admitted 500,000-row,
eight-column numeric CSV under the same controls and still requires `parse-memory`.
This proves the format guard and independent memory backstop without restoring an
avoidable allocation failure. Other original format cases remain unchanged.

The shipped `public-entry.js` regression builds a mixed project containing refused CSVs,
a valid table and a Markdown document. It checks activation, typed warnings, no prefix
table rows and cited search results for refused and valid sources. Stored warnings are
shared by CLI inspection, Studio and runtime build metadata.
