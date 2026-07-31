import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ActiveBuildProvider,
  assertBuildId,
  type BuildHandle,
  type BuildId,
  type BuildSummary,
  LoreError,
} from '@lorepack/core';
import { loadMigrations, runMigrations } from './migrations.js';
import { openReadOnly, openWritable } from './sqlite.js';

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
    const db = openWritable(join(loreDirectory, 'state.sqlite'));
    runMigrations(db, loadMigrations(migrationsDirectory));
    return new LocalStateStore(db, loreDirectory);
  }

  close(): void {
    this.#db.close();
  }

  get loreDirectory(): string {
    return this.#loreDirectory;
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
        remediation: 'Run `lore inspect builds` to list available builds.',
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

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `UPDATE active_build
             SET build_id = ?, generation = generation + 1, activated_at = ?
           WHERE id = 1`,
        )
        .run(buildId, now());
      this.#db.prepare("UPDATE builds SET state = 'verified' WHERE state = 'active'").run();
      this.#db.prepare("UPDATE builds SET state = 'active' WHERE build_id = ?").run(buildId);
      this.#db.exec('COMMIT');
    } catch (cause) {
      this.#db.exec('ROLLBACK');
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

  constructor(state: LocalStateStore, buildsDirectory: string) {
    this.#state = state;
    this.#buildsDirectory = buildsDirectory;
  }

  async current(): Promise<{ buildId: BuildId; generation: number } | null> {
    return this.#state.current();
  }

  async acquire(): Promise<BuildHandle> {
    // Re-read on every acquisition. A missed filesystem notification is harmless because
    // the request boundary is what observes the generation.
    const active = this.#state.current();
    if (active === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build.', {
        remediation: 'Run `lore build` to create and activate one.',
      });
    }

    let entry = this.#open.get(active.buildId);
    if (entry === undefined) {
      entry = {
        db: openReadOnly(join(this.#buildsDirectory, active.buildId, 'context.sqlite')),
        refs: 0,
      };
      this.#open.set(active.buildId, entry);
    }
    entry.refs += 1;

    let released = false;
    const self = this;
    return {
      buildId: active.buildId,
      generation: active.generation,
      release(): void {
        if (released) return;
        released = true;
        self.#release(active.buildId);
      },
    };
  }

  /** The database backing a handle. Only the runtime's data access layer calls this. */
  database(handle: BuildHandle): DatabaseSync {
    const entry = this.#open.get(handle.buildId);
    if (entry === undefined) {
      throw new LoreError('LORE_E_INTERNAL', 'This build handle has already been released.', {
        subject: handle.buildId,
      });
    }
    return entry.db;
  }

  get openBuildCount(): number {
    return this.#open.size;
  }

  #release(buildId: BuildId): void {
    const entry = this.#open.get(buildId);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;

    // Keep the currently active build open; closing it would reopen on the next request
    // for no benefit. Anything else is a drained older build.
    if (this.#state.current()?.buildId === buildId) return;
    entry.db.close();
    this.#open.delete(buildId);
  }

  closeAll(): void {
    for (const entry of this.#open.values()) entry.db.close();
    this.#open.clear();
  }
}
