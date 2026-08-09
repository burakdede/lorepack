import type { AuthorizationRequest } from '@lorepack/runtime';

export interface RuntimeAuthStatementLike {
  bind(...values: unknown[]): RuntimeAuthStatementLike;
  run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
}

export interface RuntimeAuthDatabaseLike {
  prepare(query: string): RuntimeAuthStatementLike;
}

interface RuntimeTokenRow {
  readonly tokenHash: string;
}

export const RUNTIME_TOKEN_PREFIX = 'lore_rt_' as const;
export const RUNTIME_TOKENS_TABLE = `CREATE TABLE IF NOT EXISTS runtime_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
)`;

export async function storeRuntimeTokenHash(
  db: RuntimeAuthDatabaseLike,
  tokenHash: string,
  now: string,
): Promise<void> {
  await db.prepare(RUNTIME_TOKENS_TABLE).run();
  await db.prepare('DELETE FROM runtime_tokens').run();
  await db
    .prepare('INSERT INTO runtime_tokens (token_hash, created_at) VALUES (?, ?)')
    .bind(tokenHash, now)
    .run();
}

export async function revokeRuntimeTokens(db: RuntimeAuthDatabaseLike): Promise<number> {
  await db.prepare(RUNTIME_TOKENS_TABLE).run();
  const rows = await db
    .prepare('SELECT token_hash AS tokenHash FROM runtime_tokens ORDER BY token_hash')
    .run<RuntimeTokenRow>();
  const count = rows.results?.length ?? 0;
  await db.prepare('DELETE FROM runtime_tokens').run();
  return count;
}

export async function hasRuntimeToken(db: RuntimeAuthDatabaseLike): Promise<boolean> {
  await db.prepare(RUNTIME_TOKENS_TABLE).run();
  const rows = await db
    .prepare('SELECT token_hash AS tokenHash FROM runtime_tokens ORDER BY token_hash LIMIT 1')
    .run<RuntimeTokenRow>();
  return (rows.results?.length ?? 0) > 0;
}

export function createRuntimeTokenAuthorizer(
  db: RuntimeAuthDatabaseLike,
): (request: AuthorizationRequest) => Promise<boolean | string> {
  return async (request) => {
    const token = bearerTokenFrom(request.authorization);
    if (token === null) return 'This token is not valid for this build.';
    if (!token.startsWith(RUNTIME_TOKEN_PREFIX)) return 'This token is not valid for this build.';
    const candidate = await hashRuntimeToken(token);
    const hashes = await readRuntimeTokenHashes(db);
    if (hashes.length === 0) return 'This token is not valid for this build.';
    for (const hash of hashes) {
      if (constantTimeEqualHex(candidate, hash)) return true;
    }
    return 'This token is not valid for this build.';
  };
}

export async function hashRuntimeToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return hexOf(new Uint8Array(digest));
}

async function readRuntimeTokenHashes(db: RuntimeAuthDatabaseLike): Promise<readonly string[]> {
  await db.prepare(RUNTIME_TOKENS_TABLE).run();
  const rows = await db
    .prepare('SELECT token_hash AS tokenHash FROM runtime_tokens ORDER BY token_hash')
    .run<RuntimeTokenRow>();
  return (rows.results ?? []).map((row) => row.tokenHash);
}

function bearerTokenFrom(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const leftBytes = bytesFromHex(left);
  const rightBytes = bytesFromHex(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let different = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    different |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return different === 0;
}

function bytesFromHex(input: string): Uint8Array {
  if (input.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(input.length / 2);
  for (let index = 0; index < input.length; index += 2) {
    const byte = Number.parseInt(input.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) return new Uint8Array();
    bytes[index / 2] = byte;
  }
  return bytes;
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
