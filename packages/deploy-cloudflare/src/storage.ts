import {
  type ActiveBuildProvider,
  assertBuildId,
  type BuildHandle,
  type BuildId,
  type BuildSelection,
  buildSelectionSchema,
  LoreError,
  type ObjectStore,
  type RuntimeIdentity,
} from '@lorepack/core/worker';
import { r2ObjectKey } from './r2-keys.js';
import { acquireReadOwnership } from './read_ownership.js';
import { checkedRuntimeIdentity } from './runtime-identity.js';

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
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
  delete?(key: string): Promise<unknown>;
}

interface ActiveBuildRow extends RuntimeIdentity {
  readonly projectId: string;
  readonly buildId: string | null;
  readonly generation: number;
}

export const ACTIVE_BUILD_QUERY = `SELECT a.build_id AS buildId, a.generation,
  i.project_id AS projectId, i.corpus_id AS corpusId, i.namespace_id AS namespaceId
FROM active_build a LEFT JOIN runtime_identity i ON i.id = a.id WHERE a.id = 1`;

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
  readonly #projectId: string;
  readonly #handles = new WeakSet<BuildHandle>();

  constructor(db: D1DatabaseLike, projectId: string) {
    this.#db = db;
    this.#projectId = projectId;
  }

  async current(): Promise<{ buildId: BuildId; generation: number } | null> {
    const row = await this.#activeRow();
    if (row === null || row.buildId === null) return null;
    checkedRuntimeIdentity(row, this.#projectId);
    return { buildId: assertBuildId(row.buildId), generation: Number(row.generation) };
  }

  async acquire(selection: BuildSelection = {}): Promise<BuildHandle> {
    const parsed = buildSelectionSchema.safeParse(selection);
    if (!parsed.success)
      throw new LoreError('LORE_E_INVALID_ARGUMENT', 'The build selection is invalid.', {
        remediation: 'Pass a full retained build ID, or omit buildId to read the active build.',
      });
    const selectedBuildId =
      parsed.data.buildId === undefined ? undefined : assertBuildId(parsed.data.buildId);
    const ownership = await acquireReadOwnership(this.#db, this.#projectId, selectedBuildId);
    if (ownership === null) {
      const active = await this.#activeRow();
      if (active === null || (active.buildId === null && parsed.data.buildId === undefined)) {
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This deployment has no active build.', {
          remediation: 'Deploy and activate a verified build before serving requests from it.',
        });
      }
      checkedRuntimeIdentity(active, this.#projectId);
      throw new LoreError(
        'LORE_E_BUILD_NOT_FOUND',
        'The selected build is not retained and available for acquisition.',
        {
          remediation:
            'Select a verified retained build in this project. No active fallback is permitted.',
          ...(parsed.data.buildId === undefined ? {} : { subject: parsed.data.buildId }),
        },
      );
    }
    let identity: RuntimeIdentity;
    let buildId: BuildId;
    try {
      identity = checkedRuntimeIdentity(ownership, this.#projectId);
      buildId = assertBuildId(ownership.buildId);
    } catch (error) {
      await ownership.release();
      throw error;
    }
    const handle: BuildHandle = Object.freeze({
      ...identity,
      buildId,
      generation: Number(ownership.generation),
      release: async () => {
        this.#handles.delete(handle);
        await ownership.release();
      },
    });
    this.#handles.add(handle);
    return handle;
  }

  assertHandle(handle: BuildHandle): void {
    if (!this.#handles.has(handle)) {
      throw new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        'The build handle is foreign, forged or released.',
        {
          remediation: 'Acquire a new handle from this runtime provider.',
          subject: handle.buildId,
        },
      );
    }
  }

  async #activeRow(): Promise<ActiveBuildRow | null> {
    try {
      return await this.#db.prepare(ACTIVE_BUILD_QUERY).first<ActiveBuildRow>();
    } catch (cause) {
      throw new LoreError(
        'LORE_E_SCHEMA_MISMATCH',
        'The deployment runtime binding could not be read.',
        {
          remediation:
            'Deploy the local corpus with this version, or restore damaged deployment state.',
          cause,
        },
      );
    }
  }
}
