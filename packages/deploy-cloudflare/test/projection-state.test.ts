import { describe, expect, it } from 'vitest';
import { PROJECTION_SCHEMA_VERSION } from '../src/projection-schema.js';
import {
  assertProjectionReadable,
  type ProjectionStateDatabaseLike,
} from '../src/projection-state.js';

const BUILD = `lore_${'a'.repeat(64)}`;
const PROJECT = 'demo';

class FakePreparedStatement {
  readonly #db: FakeD1Database;
  readonly #query: string;
  readonly #bindings: readonly unknown[];

  constructor(db: FakeD1Database, query: string, bindings: readonly unknown[] = []) {
    this.#db = db;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.#db, this.#query, values);
  }

  async run<T>(): Promise<{ readonly results?: readonly T[] }> {
    this.#db.calls.push({ query: this.#query, bindings: [...this.#bindings] });
    return {
      results: (this.#db.handlers.get(this.#query)?.(this.#bindings) ?? []) as readonly T[],
    };
  }
}

class FakeD1Database implements ProjectionStateDatabaseLike {
  readonly calls: Array<{ query: string; bindings: unknown[] }> = [];
  readonly handlers = new Map<string, (bindings: readonly unknown[]) => readonly unknown[]>();

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this, query);
  }
}

const PROJECTION_QUERY = `SELECT build_schema_version AS buildSchemaVersion,
       projection_schema_version AS projectionSchemaVersion
FROM projected_builds
WHERE project_id = ? AND build_id = ?
LIMIT 1`;

describe('assertProjectionReadable', () => {
  it('accepts the current projected schema versions', async () => {
    const db = new FakeD1Database();
    db.handlers.set(PROJECTION_QUERY, ([projectId, buildId]) =>
      projectId === PROJECT && buildId === BUILD
        ? [{ buildSchemaVersion: 3, projectionSchemaVersion: PROJECTION_SCHEMA_VERSION }]
        : [],
    );

    await expect(
      assertProjectionReadable(db, { projectId: PROJECT, buildId: BUILD }),
    ).resolves.toBeUndefined();
    expect(db.calls[0]?.bindings).toEqual([PROJECT, BUILD]);
  });

  it('refuses an older projected schema at the request boundary', async () => {
    const db = new FakeD1Database();
    db.handlers.set(PROJECTION_QUERY, () => [
      { buildSchemaVersion: 2, projectionSchemaVersion: 0 },
    ]);

    await expect(
      assertProjectionReadable(db, { projectId: PROJECT, buildId: BUILD }),
    ).rejects.toMatchObject({
      code: 'LORE_E_SCHEMA_MISMATCH',
    });
  });
});
