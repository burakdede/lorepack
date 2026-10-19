# Pinned dependency provenance and command evidence

Issue [#623](https://github.com/burakdede/lorepack/issues/623) corrects the release
supply-chain report, which previously attributed a latest release's npm attestation
to a different, pinned version. It also removes Windows-only clean-result fallbacks.

The [npm view reference](https://docs.npmjs.com/cli/v11/commands/npm-view/) specifies
that an unversioned query selects `latest`. Dependency attestations must therefore
come from `npm view <name>@<exact-version> ... --json`, independently of the latest
release observations used to evaluate maintenance age.

## Verification plan

Run the focused offline boundary regressions and existing release-policy suite:

```sh
pnpm exec vitest run tools/arch/test/pinned-supply-chain.test.ts tools/arch/test/release-policy.test.ts
```

The tests retain latest/pinned attestation disagreement in both directions, explicit
zero counts, malformed and absent package-manager JSON, missing installed packages,
nonzero command errors, pinned-provenance report freshness and advancing UTC age.
They do not contact the registry or require credentials. The normal native matrix
must execute the same tests on Windows, macOS and Linux.

The real report refresh and gate run are separate checks:

```sh
pnpm supply-chain:report
pnpm check:supply-chain
```

On macOS with Node 24.21.0 and pnpm 11.18.0, the initial focused suite failed 60
tests against the old behavior. After the implementation, the focused suite passed
108 tests. The live `pnpm licenses list --prod --json` output exposed `versions`
and `paths` arrays per installed package. Separate failing regressions caught the
parser's singular `version` assumption and a missing installed path before fixing
them.

The unmodified `pnpm supply-chain:report` command refreshed the report from real
registry and package-manager output on 2026-10-19. The following unmodified
`pnpm check:supply-chain` passed: 59 direct dependencies, 11 licenses, 17 missing
pinned provenance attestations, clean production audit and contributor audit below
High. Both `react@19.2.0` and `react-dom@19.2.0` are among the missing pinned
attestations. The refreshed report records 12 stale dependencies, each with a
version-specific decision in `scripts/supply-chain-exceptions.json`.

`pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2024 --module NodeNext
--moduleResolution NodeNext --types node,vitest/globals --allowJs --skipLibCheck
tools/arch/test/pinned-supply-chain.test.ts tools/arch/test/release-policy.test.ts`
passed. The native Windows and Linux matrix has not run for this change yet.
