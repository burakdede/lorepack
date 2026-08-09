import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  createRuntimeTokenAuthorizer,
  type RuntimeAuthDatabaseLike,
  type RuntimeTokenAuthorizer,
} from './runtime-auth.js';

export interface CloudflareAccessBindings {
  readonly CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  readonly CLOUDFLARE_ACCESS_AUD?: string;
}

export interface CloudflareAccessConfig {
  readonly teamDomain: string;
  readonly audience: string;
  readonly verifyToken?: (token: string) => Promise<boolean>;
}

interface NormalizedCloudflareAccessConfig {
  readonly audience: string;
  readonly issuer: string;
  readonly jwksUrl: URL;
}

const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const UNAUTHORIZED_MESSAGE = 'This request is not authorized for this build.';

export function resolveCloudflareAccessConfigFromBindings(
  bindings: CloudflareAccessBindings,
): CloudflareAccessConfig | undefined {
  const teamDomain = bindings.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim();
  const audience = bindings.CLOUDFLARE_ACCESS_AUD?.trim();
  if (teamDomain === undefined && audience === undefined) return undefined;
  if (teamDomain === undefined || teamDomain === '') {
    throw new Error(
      'Cloudflare Access requires CLOUDFLARE_ACCESS_TEAM_DOMAIN when CLOUDFLARE_ACCESS_AUD is set.',
    );
  }
  if (audience === undefined || audience === '') {
    throw new Error(
      'Cloudflare Access requires CLOUDFLARE_ACCESS_AUD when CLOUDFLARE_ACCESS_TEAM_DOMAIN is set.',
    );
  }
  return { teamDomain, audience };
}

export function createCloudflareAccessAuthorizer(
  config: CloudflareAccessConfig,
): RuntimeTokenAuthorizer {
  const normalized = normalizeCloudflareAccessConfig(config);
  const verifyToken = config.verifyToken ?? createAccessTokenVerifier(normalized);
  return async (request) => {
    const token = request.headers.get(ACCESS_JWT_HEADER)?.trim();
    if (token === undefined || token === '') return UNAUTHORIZED_MESSAGE;
    try {
      return (await verifyToken(token)) ? true : UNAUTHORIZED_MESSAGE;
    } catch {
      return UNAUTHORIZED_MESSAGE;
    }
  };
}

export interface CloudflareRequestAuthorizerOptions {
  readonly access?: CloudflareAccessConfig;
  readonly runtimeAuthDb?: RuntimeAuthDatabaseLike;
  readonly now?: () => string;
}

export function createCloudflareRequestAuthorizer(
  options: CloudflareRequestAuthorizerOptions,
): RuntimeTokenAuthorizer | undefined {
  const runtime =
    options.runtimeAuthDb === undefined
      ? undefined
      : createRuntimeTokenAuthorizer(options.runtimeAuthDb, options.now);
  const access =
    options.access === undefined ? undefined : createCloudflareAccessAuthorizer(options.access);

  if (runtime === undefined) return access;
  if (access === undefined) return runtime;

  return async (request) => {
    if (await authorized(runtime, request)) return true;
    if (await authorized(access, request)) return true;
    return UNAUTHORIZED_MESSAGE;
  };
}

function createAccessTokenVerifier(
  config: NormalizedCloudflareAccessConfig,
): (token: string) => Promise<boolean> {
  const jwks = createRemoteJWKSet(config.jwksUrl);
  return async (token) => {
    await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
    });
    return true;
  };
}

async function authorized(
  authorize: RuntimeTokenAuthorizer,
  request: Parameters<RuntimeTokenAuthorizer>[0],
): Promise<boolean> {
  return (await authorize(request)) === true;
}

function normalizeCloudflareAccessConfig(
  config: CloudflareAccessConfig,
): NormalizedCloudflareAccessConfig {
  const audience = config.audience.trim();
  if (audience === '') throw new Error('Cloudflare Access audience must not be empty.');
  const issuerUrl = normalizedTeamDomainUrl(config.teamDomain);
  return {
    audience,
    issuer: issuerUrl.toString().replace(/\/$/, ''),
    jwksUrl: new URL('/cdn-cgi/access/certs', issuerUrl),
  };
}

function normalizedTeamDomainUrl(teamDomain: string): URL {
  const trimmed = teamDomain.trim();
  if (trimmed === '') throw new Error('Cloudflare Access team domain must not be empty.');
  const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      'Cloudflare Access team domain must be only the hostname, without a path, query, or fragment.',
    );
  }
  return new URL(`https://${url.host}/`);
}
