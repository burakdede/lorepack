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
