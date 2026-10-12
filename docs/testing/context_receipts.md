# Detached receipt verification

Verified on 2026-10-12 with Node24.21.0, macOS arm64, Playwright1.62.1 and
Chromium151.0.7922.34. Studio uses the actual bundled CLI server and HTTP SDK.

- Assemble with receipts off: no receipt section or server retention.
- Select Keep a receipt. Task capture remains off until explicitly selected.
- Assemble, edit the task form, then save exact context and receipt. Downloads
  retain the assembled response; they do not rerun the edited request.
- Compare downloaded bytes with the actual HTTP response. Independently check
  SHA256, byte count, full build ID and explicit request-retention flag.
- Check desktop1280 light and mobile390 dark. Long identities wrap, actions remain
  available, no horizontal overflow and no serious/critical axe violations.
- SDK corruption regressions cover changed payload/newline, altered digests,
  unsupported version, absent header and unknown receipt fields. All refuse
  with LORE_E_SCHEMA_MISMATCH without retrying the context POST.

Commands executed:

```sh
pnpm exec vitest run apps/studio/test/playground.test.tsx apps/studio/test/equivalents.test.tsx
pnpm --filter @lorepack/studio-e2e exec playwright test receipts.spec.ts
```

Component/equivalent tests:29 passed. Actual browser downloads:2 passed.
Screenshots were inspected. Full release qualification remains separate #102.

![Desktop receipt](../images/context-receipt-desktop.png)
![Mobile receipt with explicit task capture](../images/context-receipt-mobile.png)

## Worker and installed-package evidence

Projected Worker HTTP/MCP receipts verify retained build A after B activation and removal
of the producing build directory. Explicit request capture and corruption refusal pass.
An allowed browser origin can read the detached header; no allowlist is widened.
Actual Wrangler4.119.0 Workerd/D1/R2 emulation passed all3 tests, including both receipt
transports. Initial context assertions exposed missing search tables in the older fixture;
its seed now uses the actual projection migration statements and a real indexed chunk.

`pnpm check:packed-cli` installed145 packages with npm, matched the tested production tree,
validated and imported the immutable archive, removed its producer, then verified exact
JSON/Markdown stdout receipt digests and byte counts. Archive/table-child/PDF checks passed;
`npm audit --omit=dev` reported0 vulnerabilities. The script's8 focused tests also pass.
Hosted receipt assertions are part of the existing credentialed deployment acceptance
flow; local emulation does not count as real hosted verification.
