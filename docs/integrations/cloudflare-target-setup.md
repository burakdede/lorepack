# Cloudflare target setup

Verified on **2026-08-08** against:

- Cloudflare token creation docs: <https://developers.cloudflare.com/fundamentals/api/get-started/create-token/>
- Cloudflare permissions catalog: <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
- Pinned local Wrangler help from `packages/deploy-cloudflare/node_modules/wrangler/bin/wrangler.js`

## What `lore target add cloudflare` needs today

The current Phase 6 reference path works with three account-scoped Cloudflare resource types:

- one **Worker**
- one **D1** database
- one **R2** bucket

Lorepack does not create or manage zones for this path, and it does not need Pages, KV, Queues,
Vectorize, Durable Objects, or AI permissions.

## Least-privilege token shape

The smallest current account-scoped token for the checked-in Phase 6 setup and deploy path is:

- `Workers Scripts Edit`
- `D1 Edit`
- `Workers R2 Storage Edit`

Optional additions:

- `Workers Tail Read`: only if you need `wrangler tail` during debugging.
- `Account Settings Read`: only if your own operational tooling needs extra account metadata
  beyond the resource mutations above.

Why these three are enough:

- the Worker runtime is a Cloudflare Worker script
- the projected catalog is stored in D1
- normalized objects and build archives are stored in R2

`Edit` is the right level because Cloudflare documents it as the full read/write permission in the
token creation flow. Lorepack needs create, update, and read behavior for these resources, not
just inspection.

## What must not be written locally

`.lore/targets/cloudflare.json` is limited to non-secret identifiers and capability metadata:

- account id
- Worker name
- D1 database name
- R2 bucket name
- advertised runtime capabilities

Never write any of these to the project:

- API tokens
- OAuth access tokens
- account email addresses
- hashed or plaintext bearer tokens for the public runtime

Deployment credentials stay in Wrangler or Cloudflare, not in `lore.yaml` and not in the target
receipt.

## Runtime bearer token flow

As of **2026-08-09**, the deployed Worker read surface is no longer anonymous. After
`lore target add cloudflare`, issue a runtime token exactly once with:

```text
lore target token cloudflare
```

That command stores only a SHA-256 hash in the remote D1 catalog and prints the plaintext token
once. Set it in your shell before remote reads, deploy confirmation, or rollback confirmation:

```text
export LORE_REMOTE_BEARER_TOKEN=<token>
```

Only Lore-generated runtime tokens are accepted on the remote read surface. Today that means a
bearer token with the `lore_rt_` prefix. A Cloudflare deployment credential such as
`CLOUDFLARE_API_TOKEN` is never a valid runtime token, even if someone hashes and stores it by
mistake.

Use `lore target token cloudflare --rotate` to replace the token, or
`lore target token cloudflare --revoke` to remove it. The token must not be written to the
project receipt or committed to the repository.

## Current command boundary

As of **2026-08-08**, `lore target add cloudflare` supports two setup behaviors:

1. `--dry-run`: show the deterministic resource names and write nothing.
2. connect existing resources with explicit identifiers:
   `--account-id`, `--worker`, `--catalog-db`, `--objects-bucket`

Automatic provisioning is still open work in Phase 6. Until that lands, the deterministic names
in the dry-run plan are a proposed resource plan, not proof that those resources already exist.
