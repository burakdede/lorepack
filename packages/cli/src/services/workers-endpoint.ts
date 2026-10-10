import { LoreError } from '@lorepack/core';

/**
 * The public URL of the deployed Worker.
 *
 * A `workers.dev` URL is `https://<worker>.<account-subdomain>.workers.dev`. The first version
 * built `https://<worker>.workers.dev`, which never resolves (#580): the printed endpoint was
 * wrong, and the post-activation smoke check could never confirm anything. The subdomain is an
 * account setting, so it is asked for rather than guessed.
 */

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = /^[0-9A-Za-z_-]{1,64}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export interface SubdomainLookupOptions {
  /** A Cloudflare API token with Workers Scripts Read or Edit, as Wrangler also reads it. */
  readonly token: string | undefined;
  readonly fetch?: typeof fetch;
}

/**
 * `GET /accounts/:id/workers/subdomain`, which returns `{ result: { subdomain } }`.
 *
 * Null rather than an error for every failure: the caller has a better remediation than this
 * function does (record the endpoint by hand), and a lookup is only one of two sources.
 */
export async function lookupWorkersSubdomain(
  accountId: string,
  options: SubdomainLookupOptions,
): Promise<string | null> {
  const token = options.token?.trim();
  if (token === undefined || token === '' || !ACCOUNT_ID.test(accountId)) return null;
  try {
    const response = await (options.fetch ?? fetch)(
      `${CLOUDFLARE_API}/accounts/${accountId}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      readonly success?: unknown;
      readonly result?: { readonly subdomain?: unknown } | null;
    };
    const subdomain = payload.success === true ? payload.result?.subdomain : undefined;
    return typeof subdomain === 'string' && HOST_LABEL.test(subdomain) ? subdomain : null;
  } catch {
    return null;
  }
}

export function workersDevEndpoint(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/**
 * Validates an endpoint a user typed, as an https origin with nothing after it.
 *
 * An origin rather than a URL with a path because Lorepack appends its own routes (`/mcp`,
 * `/v1/build`), and https only because the runtime bearer token travels in a header to it.
 */
export function parseEndpointOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidEndpoint(value);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw invalidEndpoint(value);
  }
  return url.origin;
}

function invalidEndpoint(value: string): LoreError {
  return new LoreError('LORE_E_INVALID_ARGUMENT', `${value} is not a usable endpoint.`, {
    remediation:
      'Pass the Worker origin only, for example `--endpoint https://<worker>.<subdomain>.workers.dev`.',
    subject: 'endpoint',
  });
}
