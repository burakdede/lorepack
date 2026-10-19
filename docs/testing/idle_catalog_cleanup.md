# Idle catalog cleanup

Issue [#566](https://github.com/burakdede/lorepack/issues/566) retains the original requirement:
prune a previously served build after another process activates its replacement, before
any further server request. The earlier next-request sweep was a partial correction.

## Actual failure and regression

`packages/cli/test/prune_idle.e2e.test.ts` drives the shipped `public-entry.js` binary:

1. Build A and start the real read-only server.
2. Complete a cited search over HTTP or MCP.
3. Build and activate B in a separate CLI process.
4. Run real `prune --keep 0 --yes` before sending any more server request.
5. Assert A's directory is removed, B remains and the same running server reads B.

Before correction, both protocol cases reported `applied: true` but `remove: []`, with one
reader reference retaining A. A provider integration case also found one connection open
after its final release. All three were genuine failures on main 138c4db2. Their raw logs
are retained beside the repository in
`lorepack_release_evidence/idle_catalogs/566/`.

After correction, the final release closes the connection and then its reader reference.
The provider test keeps a native prepared statement alive to verify that close also
invalidates it. The same public-binary fixture must pass on Windows before this task closes;
a later request or a successful no-op prune does not establish Windows deletion.

```bash
pnpm build
pnpm exec vitest run packages/backend-local/test/storage.test.ts packages/cli/test/prune_idle.e2e.test.ts packages/cli/test/inflight_retention.test.ts packages/cli/test/runtime-local.test.ts packages/cli/test/retained-builds.e2e.test.ts
```

On 2026-10-17, Node 24.21.0/macOS arm64: all 90 cases passed after the lifetime correction.
Native Linux/Windows qualification, installed-artifact proof and the full final local
verifier remain separate obligations.

## Preserved ownership checks

The original explicitly selected HTTP/stdio MCP server tests and the 200 captured-reader
workload remain unchanged. They still require a live owner to retain A across B activation
and separate-process prune, with every captured read returning A's original content.

Six older assertions assumed an unowned active connection remained cached. The original
failed run is retained. Cache-only counts now require zero drained connections, a stricter
resource bound. Cases that must prove protection, released-handle rejection or backend
shutdown against an actually open connection now hold an explicit reader. Their original
protection/branding/shutdown assertions remain. Original case names, input corpus, reader
counts, deadlines, skips and other qualification controls are preserved.

## Retrieval cost

The existing `scripts/bench-retrieval.mjs` ran unchanged with its defaults: 400 documents,
eight sections each, 3,200 chunks, 60 iterations and five queries. Both reports identify
Node 24.21.0, macOS arm64 and the Apple M1 Pro/32 GB development machine. Sequential calls
still warm OS caches; each now reopens its connection.

| Measurement | [Before](evidence/566_retrieval_before.json) | [After](evidence/566_retrieval_after.json) | Existing target value |
|---|---:|---:|---:|
| Search p95, ms | 24.56 | 19.44 | 250 |
| Context p95, ms | 603.89 | 594.45 | 1,500 |

This one local comparison establishes that both runs remain within those target values;
it does not establish a speedup or reference-hardware release signoff. Keep the exact
workload and final release performance obligations intact.

## Connection diagnostic qualification

Connection verification accepts an optional diagnostic observer. Events record child launch
ordinals and PIDs, exit codes/signals, SDK negotiation fields and explicit discovery results.
Discovery errors use the fixed `Error`/`OtherError` enum and a safe integer code or `null`.
The exit event reports only a boolean for the fixed parser resident-memory observer failure
phrase. Events contain no raw stderr, command arguments, paths or document content.
Observers and diagnostic field access cannot change protocol verification or child cleanup;
when no observer is supplied, diagnostic fields are not read.

Child exit diagnostics use Node's `close` event, which follows process exit and stdio closure.
Cleanup can finish before that event reaches a bounded test snapshot. A missing exit event
is inconclusive. These diagnostics do not establish the cause of historical reader SIGKILL
or protocol fallback failures.

```bash
pnpm build
pnpm exec vitest run packages/connect-clients/test/verify.test.ts packages/connect-clients/test/verify_process.test.ts packages/backend-local/test/storage.test.ts packages/cli/test/prune_idle.e2e.test.ts packages/cli/test/inflight_retention.test.ts packages/cli/test/runtime-local.test.ts
```

On 2026-10-19, Node 24.21.0/macOS arm64: the three diagnostic safety regressions first failed;
a further throwing error-code getter regression failed with diagnostics enabled and disabled.
After the diagnostic safety corrections, all five cases passed and the six-file run passed
86 cases. The real SDK discovery call, protocol assertions and original deadlines remain.
This focused run does not replace full local or native Windows/Linux qualification.
