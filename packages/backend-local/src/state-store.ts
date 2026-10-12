import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ActiveBuildProvider,
  assertBuildId,
  type BuildHandle,
  type BuildId,
  type BuildSummary,
  LoreError,
  type RuntimeIdentity,
  runtimeIdentitySchema,
} from '@lorepack/core';
import { assertMigrationsKnown, loadMigrations, runMigrations } from './migrations.js';
import { inTransaction, openReadOnly, openWritable } from './sqlite.js';

/**
 * The one mutable database in a project. Sealed builds are opened read-only forever, so
 * every changing fact (which build is active, what has been built, how long it took)
 * lives here.
 */
export class LocalStateStore {
  readonly #db: DatabaseSync;
  readonly #loreDirectory: string;

  private constructor(db: DatabaseSync, loreDirectory: string) {
    this.#db = db;
    this.#loreDirectory = loreDirectory;
  }

  static open(loreDirectory: string, migrationsDirectory: string): LocalStateStore {
    mkdirSync(loreDirectory, { recursive: true });
    const path = join(loreDirectory, 'state.sqlite');
    const migrations = loadMigrations(migrationsDirectory);
    // Checked on a read-only connection first, because opening for writing already writes:
    // it sets the journal mode. State from a newer Lorepack is refused untouched (#570).
    if (existsSync(path)) {
      const probe = openReadOnly(path);
      try {
        assertMigrationsKnown(probe, migrations);
      } finally {
        probe.close();
      }
    }
    const db = openWritable(path);
    try {
      runMigrations(db, migrations);
      const store = new LocalStateStore(db, loreDirectory);
      store.identity();
      return store;
    } catch (cause) {
      db.close();
      throw cause;
    }
  }

  close(): void {
    this.#db.close();
  }

  get loreDirectory(): string {
    return this.#loreDirectory;
  }

  identity(): RuntimeIdentity {
    let row: unknown;
    try {
      row = this.#db
        .prepare(
          'SELECT corpus_id AS corpusId, namespace_id AS namespaceId FROM runtime_identity WHERE id = 1',
        )
        .get();
    } catch (cause) {
      throw new LoreError(
        'LORE_E_SCHEMA_MISMATCH',
        'The project runtime identity could not be read.',
        {
          remediation: 'Restore the project state from a known-good backup.',
          cause,
        },
      );
    }
    const parsed = runtimeIdentitySchema.safeParse(row);
    if (!parsed.success) {
      throw new LoreError(
        'LORE_E_SCHEMA_MISMATCH',
        'The project runtime identity is missing or invalid.',
        {
          remediation:
            'Restore the project state from a known-good backup. Identity cannot be regenerated safely.',
        },
      );
    }
    return parsed.data;
  }

  recordBuild(summary: BuildSummary): void {
    this.#db
      .prepare(
        `INSERT INTO builds (build_id, state, created_at, artifacts, nodes, chunks, tables_, table_rows)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (build_id) DO UPDATE SET state = excluded.state`,
      )
      .run(
        summary.buildId,
        summary.state,
        summary.createdAt,
        summary.counts.artifacts,
        summary.counts.nodes,
        summary.counts.chunks,
        summary.counts.tables,
        summary.counts.tableRows,
      );
  }

  /**
   * Removes a build record. Only retention calls this, and never for the active build:
   * the pointer must always name a build that exists.
   */
  forgetBuild(buildId: BuildId): void {
    if (this.current()?.buildId === buildId) {
      throw new LoreError('LORE_E_INVALID_ARGUMENT', 'The active build cannot be removed.', {
        remediation: 'Activate another build first.',
        subject: buildId,
      });
    }
    this.#db.prepare('DELETE FROM builds WHERE build_id = ?').run(buildId);
  }

  /**
   * Removes several build records in one transaction, so a failure part-way through leaves
   * every record in place rather than some of them.
   */
  forgetBuilds(buildIds: readonly BuildId[]): void {
    if (buildIds.length === 0) return;
    inTransaction(this.#db, () => {
      for (const buildId of buildIds) this.forgetBuild(buildId);
    });
  }

  listBuilds(): BuildSummary[] {
    const rows = this.#db
      .prepare('SELECT * FROM builds ORDER BY created_at DESC, build_id DESC')
      .all() as Array<Record<string, string | number>>;
    return rows.map(toSummary);
  }

  getBuild(buildId: BuildId): BuildSummary | null {
    const row = this.#db.prepare('SELECT * FROM builds WHERE build_id = ?').get(buildId) as
      | Record<string, string | number>
      | undefined;
    return row === undefined ? null : toSummary(row);
  }

  /**
   * Activation is one transaction: the pointer moves and the generation increments
   * together, or neither happens. A crash leaves the old pointer, never a torn state.
   */
  activate(buildId: BuildId, now: () => string = () => new Date().toISOString()): number {
    const build = this.getBuild(buildId);
    if (build === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} is not in this project.`, {
        remediation: 'Run `lorepack inspect builds` to list available builds.',
        subject: buildId,
      });
    }
    if (build.state !== 'verified' && build.state !== 'active') {
      throw new LoreError(
        'LORE_E_BUILD_VALIDATION',
        `Build ${buildId} is ${build.state}, and only a verified build may be activated.`,
        { remediation: 'Rebuild, or activate a build that passed validation.', subject: buildId },
      );
    }

    try {
      inTransaction(this.#db, () => {
        this.#db
          .prepare(
            `UPDATE active_build
             SET build_id = ?, generation = generation + 1, activated_at = ?
           WHERE id = 1`,
          )
          .run(buildId, now());
        this.#db.prepare("UPDATE builds SET state = 'verified' WHERE state = 'active'").run();
        this.#db.prepare("UPDATE builds SET state = 'active' WHERE build_id = ?").run(buildId);
      });
    } catch (cause) {
      if (cause instanceof LoreError) throw cause;
      throw new LoreError('LORE_E_INTERNAL', `Could not activate ${buildId}.`, { cause });
    }
    return this.currentGeneration();
  }

  current(): { buildId: BuildId; generation: number } | null {
    const row = this.#db
      .prepare('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1')
      .get() as { buildId: string | null; generation: number };
    if (row.buildId === null) return null;
    return { buildId: assertBuildId(row.buildId), generation: row.generation };
  }

  currentGeneration(): number {
    const row = this.#db.prepare('SELECT generation FROM active_build WHERE id = 1').get() as {
      generation: number;
    };
    return row.generation;
  }
}

function toSummary(row: Record<string, string | number>): BuildSummary {
  return {
    buildId: assertBuildId(String(row.build_id)),
    state: String(row.state) as BuildSummary['state'],
    createdAt: String(row.created_at),
    counts: {
      artifacts: Number(row.artifacts),
      nodes: Number(row.nodes),
      chunks: Number(row.chunks),
      tables: Number(row.tables_),
      tableRows: Number(row.table_rows),
    },
  };
}

/**
 * Hands out read-only handles on the active build, one open database per build shared by
 * reference count.
 *
 * The contract that matters (architecture section 15.2): a request acquires a handle at
 * its start and holds it for its whole life, so activation mid-request cannot mix two
 * builds into one response. The old database closes when its final in-flight request
 * releases, not when the pointer moves.
 */
export class LocalActiveBuildProvider implements ActiveBuildProvider {
  readonly #state: LocalStateStore;
  readonly #buildsDirectory: string;
  readonly #open = new Map<BuildId, { db: DatabaseSync; refs: number }>();
  readonly #handles = new WeakMap<BuildHandle, DatabaseSync>();

  constructor(state: LocalStateStore, buildsDirectory: string) {
    this.#state = state;
    this.#buildsDirectory = buildsDirectory;
  }

  async current(): Promise<{ buildId: BuildId; generation: number } | null> {
    return this.#state.current();
  }

  async acquire(): Promise<BuildHandle & RuntimeIdentity> {
    // Re-read on every acquisition. A missed filesystem notification is harmless because
    // the request boundary is what observes the generation.
    const active = this.#state.current();
    if (active === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build.', {
        remediation: 'Run `lorepack build` to create and activate one.',
      });
    }
    const identity = this.#state.identity();

    this.#closeIdle(active.buildId);

    let entry = this.#open.get(active.buildId);
    if (entry === undefined) {
      entry = {
        db: openReadOnly(join(this.#buildsDirectory, active.buildId, 'context.sqlite')),
        refs: 0,
      };
      this.#open.set(active.buildId, entry);
    }
    entry.refs += 1;
    const database = entry.db;

    let released = false;
    const self = this;
    const handle: BuildHandle & RuntimeIdentity = Object.freeze({
      ...identity,
      buildId: active.buildId,
      generation: active.generation,
      release(): void {
        if (released) return;
        released = true;
        self.#handles.delete(handle);
        self.#release(active.buildId, database);
      },
    });
    this.#handles.set(handle, database);
    return handle;
  }

  /** The database backing a handle. Only the runtime's data access layer calls this. */
  database(handle: BuildHandle): DatabaseSync {
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
    const entry = this.#open.get(handle.buildId);
    if (entry === undefined || entry.db !== this.#handles.get(handle)) {
      throw new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        'The build handle belongs to a closed runtime.',
        {
          remediation: 'Acquire a new handle from an open runtime provider.',
          subject: handle.buildId,
        },
      );
    }
    return entry.db;
  }

  get openBuildCount(): number {
    return this.#open.size;
  }

  #release(buildId: BuildId, database: DatabaseSync): void {
    const entry = this.#open.get(buildId);
    if (entry === undefined || entry.db !== database) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;

    // Keep the currently active build open; closing it would reopen on the next request
    // for no benefit. Anything else is a drained older build.
    if (this.#state.current()?.buildId === buildId) return;
    entry.db.close();
    this.#open.delete(buildId);
  }

  /**
   * Closes every database no request holds, except the active build's.
   *
   * `#release` keeps the active build open when it drains, which is right until the pointer
   * moves; after that nothing revisited the entry, so a long-running `dev` or `serve` kept one
   * database per activation open, and a pruned build's file stayed open and undeletable on
   * Windows (#566). The pointer is re-read at every acquisition, so that is where a build that
   * stopped being active is noticed.
   */
  #closeIdle(activeBuildId: BuildId): void {
    for (const [buildId, entry] of this.#open) {
      if (buildId === activeBuildId || entry.refs > 0) continue;
      entry.db.close();
      this.#open.delete(buildId);
    }
  }

  closeAll(): void {
    for (const entry of this.#open.values()) entry.db.close();
    this.#open.clear();
  }
}
