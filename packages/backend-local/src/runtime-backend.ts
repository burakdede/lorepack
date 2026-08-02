import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BuildHandle,
  type BuildManifest,
  type BuildScope,
  buildManifestSchema,
  type CatalogSearchCriteria,
  type CatalogSearchHit,
  type CatalogStore,
  LORE_DIRECTORY,
  LoreError,
  type RuntimeDeps,
  type TableDescription,
  type TableQueryRequest,
  type TableQueryResult,
  type TableStore,
} from '@lorepack/core';
import { countRows, RUNTIME_TABLES, searchCatalog } from './catalog/writer.js';
import { stateMigrationsDirectory } from './migrations-path.js';
import { FileObjectStore } from './object-store.js';
import { restrictToTables } from './sqlite.js';
import { LocalActiveBuildProvider, LocalStateStore } from './state-store.js';

/**
 * The local half of the runtime: ports over `node:sqlite` and the filesystem.
 *
 * It lives here rather than in `@lorepack/runtime` on purpose. The runtime is forbidden
 * from importing any backend, so the only thing that can know about SQLite is this file
 * and its Phase 6 counterpart over D1 and R2. That rule is machine-checked, which is what
 * makes "the same runtime runs in a Worker" a fact rather than an intention.
 */

class LocalCatalogStore implements CatalogStore {
  readonly #db: DatabaseSync;
  readonly #buildDirectory: string;

  constructor(db: DatabaseSync, buildDirectory: string) {
    this.#db = db;
    this.#buildDirectory = buildDirectory;
  }

  async manifest(): Promise<BuildManifest> {
    const path = join(this.#buildDirectory, 'manifest.json');
    if (!existsSync(path)) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This build has no manifest.', {
        remediation: 'The build directory is incomplete. Run `lore build` to create a new one.',
        subject: this.#buildDirectory,
      });
    }
    return buildManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  async countChunks(): Promise<number> {
    return countRows(this.#db, 'chunks');
  }

  async countWarnings(): Promise<number> {
    return countRows(this.#db, 'build_warnings');
  }

  async search(
    query: string,
    criteria: CatalogSearchCriteria,
  ): Promise<readonly CatalogSearchHit[]> {
    const hits = searchCatalog(this.#db, query, {
      limit: criteria.limit,
      ...(criteria.pathGlob === undefined ? {} : { pathGlob: criteria.pathGlob }),
      ...(criteria.extension === undefined ? {} : { extension: criteria.extension }),
      ...(criteria.statuses === undefined ? {} : { statuses: criteria.statuses }),
    });
    return hits.map((hit) => ({
      ...hit,
      status: hit.status as CatalogSearchHit['status'],
    }));
  }
}

/**
 * Tables arrive in Phase 5. Until then the store answers honestly rather than throwing
 * "not implemented": this build genuinely has no tables, and a caller that asks learns
 * that from an empty list and a typed error, which is the same answer it will get in
 * Phase 5 for a build that happens to contain no spreadsheet.
 */
class EmptyTableStore implements TableStore {
  async list(): Promise<readonly { readonly tableId: string; readonly name: string }[]> {
    return [];
  }

  async describe(_tableId: string): Promise<TableDescription | null> {
    return null;
  }

  async query(request: TableQueryRequest): Promise<TableQueryResult> {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No table ${request.tableId} in this build.`, {
      remediation:
        'This build declares no tables. Typed tables arrive with the CSV and XLSX parsers.',
      subject: request.tableId,
    });
  }
}

export interface LocalRuntimeOptions {
  readonly projectRoot: string;
  /** Establishes freshness. Omitted means every response reports `unknown`. */
  readonly freshness?: RuntimeDeps['freshness'];
}

export interface LocalRuntimeBackend extends RuntimeDeps {
  /** Releases every database this backend opened. The owner of the process calls it. */
  close(): void;
}

/**
 * Builds the ports for a project on disk.
 *
 * The caller owns the lifetime: `close()` releases the state database and every build
 * database the provider opened. A request never closes anything, which is what lets an
 * older build stay open until its last in-flight reader releases it.
 */
export function createLocalRuntimeBackend(options: LocalRuntimeOptions): LocalRuntimeBackend {
  const loreDirectory = join(options.projectRoot, LORE_DIRECTORY);
  const state = LocalStateStore.open(loreDirectory, stateMigrationsDirectory());
  const provider = new LocalActiveBuildProvider(state, join(loreDirectory, 'builds'));
  const objects = new FileObjectStore(join(loreDirectory, 'objects'));

  return {
    provider,
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    open: async (handle: BuildHandle): Promise<BuildScope> => {
      const db = provider.database(handle);
      // Defence in depth, and not optional: the authorizer refuses every table outside the
      // read surface, so a defect in query construction cannot reach something it should
      // not. The list also permits `PRAGMA data_version`, which FTS5 reads internally and
      // which, denied, fails `MATCH` with "authorization denied" and no hint about why.
      restrictToTables(db, RUNTIME_TABLES);
      return {
        buildId: handle.buildId,
        catalog: new LocalCatalogStore(db, join(loreDirectory, 'builds', handle.buildId)),
        tables: new EmptyTableStore(),
        objects,
      };
    },
    close: (): void => {
      provider.closeAll();
      state.close();
    },
  };
}
