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

`lore target token cloudflare --rotate` keeps the previous token valid for exactly **10
minutes**, then expires it automatically. That overlap window is there so an already-running
client can swap credentials without being cut off mid-session. During the window, both the old
and new runtime tokens work; after the window, only the new token does.

## Browser origins and Worker headers

The deployed Worker is **closed to browsers by default**. A tool or SDK that sends no
`Origin` header is unaffected, but a browser page from any unrecognised origin is refused and
gets no CORS allow header back.

If you intentionally need browser access to the remote read surface, set the Worker variable
`ALLOWED_ORIGINS` to a comma-separated list of exact origins, for example:

```text
ALLOWED_ORIGINS=https://app.example,https://admin.example
```

Only those exact origins receive CORS preflight responses and `Access-Control-Allow-Origin`.
This does not widen the authenticated read boundary: the runtime bearer token is still required
for the protected routes.

The Worker also adds a fixed response hardening set on every reply: `Content-Security-Policy`,
`Cross-Origin-Opener-Policy`, `Permissions-Policy`, `Referrer-Policy`,
`X-Content-Type-Options`, `X-Frame-Options`, and `Strict-Transport-Security` on HTTPS
requests.

Use `lore target token cloudflare --rotate` to replace the token, or
`lore target token cloudflare --revoke` to remove it. The token must not be written to the
project receipt or committed to the repository.

## Cloudflare Access as an alternative front door

As of **2026-08-09**, the checked-in Worker can also accept a valid
`Cf-Access-Jwt-Assertion` header from Cloudflare Access. This is an alternative read-surface
credential path for the same public Worker. It does not create any admin route, and it does
not make deployment credentials usable at runtime.

The current reference path works on the existing `workers.dev` endpoint. Cloudflare's current
Workers docs say you can enable Access for a `workers.dev` URL from **Workers & Pages >
<your Worker> > Settings > Domains & Routes > Enable Cloudflare Access**, and then you must
still validate the Access JWT inside the Worker with the Access audience and JWK set. Lorepack
now does that validation when the two Worker variables below are present.

Set these variables on the Worker:

```text
CLOUDFLARE_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<the Access application aud value>
```

Exact setup flow for the current Phase 6 path:

1. Deploy the Worker normally and keep `workers.dev` enabled.
2. In Cloudflare, open **Workers & Pages**, select the deployed Worker, then open
   **Settings > Domains & Routes**.
3. On the `workers.dev` route, select **Enable Cloudflare Access**.
4. If you need to adjust who can reach it, open **Manage Cloudflare Access** and update the
   Access policy there.
5. Record the Access team domain and the application `aud` value.
6. Set `CLOUDFLARE_ACCESS_TEAM_DOMAIN` and `CLOUDFLARE_ACCESS_AUD` on the Worker, then
   redeploy.

Interaction with bearer auth:

- if only the Lore runtime bearer token is configured, remote reads require that bearer token
- if Cloudflare Access is also configured, a request may authenticate with either a valid
  Lore runtime bearer token or a valid Access JWT
- deployment credentials are still rejected structurally, because only Lore runtime tokens
  with the `lore_rt_` prefix and valid Access JWTs are accepted

Cloudflare's current `workers.dev` docs also note that the Access gate can use policy rules
over the request before it reaches the Worker. For Lorepack's MCP surface, the relevant safe
policy hints are the mirrored `Mcp-Method` and `Mcp-Name` headers. The body remains the source
of truth, and the Worker still rejects header and body mismatches before authorization.

## Manual verification for the Access path

Recorded on **2026-08-09** as the required manual checklist for `#90`:

1. Enable Cloudflare Access on the deployed `workers.dev` route.
2. Set `CLOUDFLARE_ACCESS_TEAM_DOMAIN` and `CLOUDFLARE_ACCESS_AUD`, then redeploy.
3. In a private browser session, open `https://<worker>.<subdomain>.workers.dev/v1/build` and
   confirm Cloudflare Access redirects to authentication before the Worker responds.
4. After authenticating through Access, reload the same URL and confirm the Worker returns the
   build payload without a Lore bearer token.
5. In a non-browser client that sends neither a bearer token nor a valid
   `Cf-Access-Jwt-Assertion`, confirm the same URL returns `401`.
6. In a non-browser client that sends `Authorization: Bearer <lore_rt_...>`, confirm the same
   URL still returns `200` even without an Access session.
7. Send an invalid `Cf-Access-Jwt-Assertion` header and confirm the Worker returns `401`
   without exposing token material or an enumeration hint.

## Current command boundary

As of **2026-08-09**, `lore target add cloudflare` supports three setup behaviors:

1. `--dry-run`: show the deterministic resource plan and write nothing.
2. no explicit resource identifiers: create the deterministic **D1** database and **R2** bucket,
   then write the target receipt. The Worker name is recorded for the first deploy.
3. connect existing resources with explicit identifiers:
   `--account-id`, `--worker`, `--catalog-db`, `--objects-bucket`

On rerun, the command is idempotent. It reuses an unchanged receipt, checks the remote D1 and R2
resources are still visible, and reports drift if the receipt no longer matches the account state.

The Worker resource is still created by the first successful deploy rather than by target setup.
That is why reruns treat an undeployed Worker name as valid while still insisting that the D1
database and R2 bucket exist remotely.
