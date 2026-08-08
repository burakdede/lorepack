import {
  type ActiveBuildProvider,
  assertBuildId,
  type BuildHandle,
  type BuildId,
  LoreError,
  type ObjectStore,
} from '@lorepack/core/worker';

interface D1PreparedStatementLike {
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<unknown | null>;
}

interface ActiveBuildRow {
  readonly buildId: string | null;
  readonly generation: number;
}

const ACTIVE_BUILD_QUERY =
  'SELECT build_id AS buildId, generation FROM active_build WHERE id = 1' as const;

/**
 * Content-addressed build objects in an R2 bucket.
 *
 * The semantics match the local filesystem store: writes are immutable and content-derived,
 * reads verify checksums before returning bytes, and an unknown hash is an ordinary miss.
 */
export class R2ObjectStore implements ObjectStore {
  readonly #projectId: string;
  readonly #bucket: R2BucketLike;

  constructor(projectId: string, bucket: R2BucketLike) {
    this.#projectId = projectId;
    this.#bucket = bucket;
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = await sha256Hex(data);
    const key = r2ObjectKey(this.#projectId, hash);
    const existing = await this.#bucket.get(key);
    if (existing !== null) {
      await this.#readVerified(hash, existing);
      return hash;
    }
    await this.#bucket.put(key, data);
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const object = await this.#bucket.get(r2ObjectKey(this.#projectId, hash));
    if (object === null) return null;
    return this.#readVerified(hash, object);
  }

  async has(hash: string): Promise<boolean> {
    return (await this.#bucket.head(r2ObjectKey(this.#projectId, hash))) !== null;
  }

  async #readVerified(hash: string, object: R2ObjectBodyLike): Promise<Uint8Array> {
    const data = new Uint8Array(await object.arrayBuffer());
    const actual = await sha256Hex(data);
    if (actual !== hash) {
      throw new LoreError(
        'LORE_E_OBJECT_CORRUPT',
        `Object ${hash} failed its checksum and was not used.`,
        {
          remediation:
            'Project the build again so the object is uploaded cleanly. If this recurs, the deployed bucket contents are damaged.',
          subject: hash,
          details: { expected: hash, actual },
        },
      );
    }
    return data;
  }
}

export function r2ObjectKey(projectId: string, hash: string): string {
  return `${projectId}/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The active-build pointer for a deployed runtime, read fresh from D1 per request.
 *
 * A handle captures the build id and generation it observed when acquired. The runtime then
 * namespaces every later query by that build id, which is what makes one response unable to
 * mix two builds even if activation happens mid-request.
 */
export class D1ActiveBuildProvider implements ActiveBuildProvider {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async current(): Promise<{ buildId: BuildId; generation: number } | null> {
    const row = await this.#activeRow();
    if (row === null || row.buildId === null) return null;
    return { buildId: assertBuildId(row.buildId), generation: Number(row.generation) };
  }

  async acquire(): Promise<BuildHandle> {
    const active = await this.current();
    if (active === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This deployment has no active build.', {
        remediation: 'Deploy and activate a verified build before serving requests from it.',
      });
    }

    return {
      buildId: active.buildId,
      generation: active.generation,
      release() {},
    };
  }

  async #activeRow(): Promise<ActiveBuildRow | null> {
    return await this.#db.prepare(ACTIVE_BUILD_QUERY).first<ActiveBuildRow>();
  }
}
