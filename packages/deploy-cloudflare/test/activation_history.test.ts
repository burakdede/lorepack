import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildId, DeploymentReceipt } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { withTempProject } from '../../../tools/test-support/src/temp-project.js';
import { rollbackCommand } from '../../cli/src/commands/activate.js';
import { run } from '../../cli/test/helpers.js';
import { PROJECTION_MIGRATIONS } from '../src/projection-migrations.js';
import { applyRemoteRetentionPlan, planRemoteRetention } from '../src/retention.js';
import {
  ACTIVE_BUILD as A,
  CANDIDATE_BUILD as B,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from './projected-runtime-fixture.js';

const C = `lore_${'c'.repeat(64)}` as BuildId;
type Fixture = Awaited<ReturnType<typeof createProjectedWorkerRuntimeFixture>> & {
  cReceipt: DeploymentReceipt;
};

async function withHistory(body: (fixture: Fixture) => Promise<void>) {
  const fixture = await createProjectedWorkerRuntimeFixture();
  try {
    await fixture.target.verify(fixture.candidateReceipt);
    const cReceipt = await fixture.applySharedCandidate(C);
    await fixture.target.verify(cReceipt);
    await fixture.target.activate(cReceipt);
    await body({ ...fixture, cReceipt });
  } finally {
    await fixture.close();
  }
}

function pointer(fixture: Fixture) {
  return fixture.projection.raw
    .prepare('SELECT build_id, generation FROM active_build WHERE id = 1')
    .get();
}

function events(fixture: Fixture) {
  return fixture.projection.raw
    .prepare('SELECT * FROM activation_events ORDER BY generation')
    .all();
}

function legacy(fixture: Fixture) {
  fixture.projection.raw.exec(
    "DROP TRIGGER record_activation; DROP TABLE activation_events; DELETE FROM schema_migrations WHERE id = '0008';",
  );
}

describe('projected activation history', () => {
  it('rolls back to the actual predecessor, skips a never-active candidate and reverses the transition', async () => {
    await withHistory(async (fixture) => {
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 2 });
      const result = await fixture.target.rollback();
      expect(result).toMatchObject({ buildId: A, previousBuildId: C });
      expect(result.buildId).not.toBe(B);
      expect(pointer(fixture)).toEqual({ build_id: A, generation: 3 });
      expect(
        events(fixture).map((row) => [row.generation, row.previous_build_id, row.build_id]),
      ).toEqual([
        [1, null, A],
        [2, A, C],
        [3, C, A],
      ]);
      expect((await fixture.target.rollback()).buildId).toBe(C);
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 4 });
    });
  });

  it('preserves retained reads and records reactivation from an empty pointer', async () => {
    await withHistory(async (fixture) => {
      const recorded = events(fixture);
      fixture.projection.raw.exec('UPDATE active_build SET build_id = NULL WHERE id = 1');
      expect(events(fixture)).toEqual(recorded);
      expect((await fixture.runtime.describeBuild({ buildId: A })).buildId).toBe(A);
      await expect(fixture.target.rollback()).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      await fixture.target.activate(fixture.candidateReceipt);
      expect(pointer(fixture)).toEqual({ build_id: B, generation: 3 });
      expect(events(fixture)[2]).toMatchObject({
        generation: 3,
        previous_build_id: null,
        build_id: B,
        kind: 'transition',
      });
    });
  });

  it('uses the same backend selection through the real CLI command with no local sources', async () => {
    await withHistory(async (fixture) => {
      await withTempProject(
        { files: { 'lore.yaml': 'version: 1\nname: projected\nsources: [missing]\n' } },
        async (temp) => {
          const result = await run(
            ['--cwd', temp.root, '--json', 'rollback', '--target', 'cloudflare'],
            {
              commands: [rollbackCommand({ resolveTarget: async () => fixture.target })],
            },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({ buildId: A, previousBuildId: C });
          expect(pointer(fixture)).toEqual({ build_id: A, generation: 3 });
        },
      );
    });
  });

  it('refuses a bare rollback whose selection snapshot lost the final CAS race', async () => {
    await withHistory(async (fixture) => {
      const prepare = fixture.projection.prepare.bind(fixture.projection);
      let armed = true;
      fixture.projection.prepare = (query) => {
        const statement = prepare(query);
        const execute = statement.run.bind(statement);
        statement.run = async <T = Record<string, unknown>>() => {
          const response = await execute<T>();
          if (armed && query.startsWith('SELECT a.build_id AS activeBuildId')) {
            armed = false;
            await fixture.target.activate(fixture.candidateReceipt);
          }
          return response;
        };
        return statement;
      };
      await expect(fixture.target.rollback()).rejects.toMatchObject({
        code: 'LORE_E_REMOTE_DEPLOY',
        details: { reason: 'activation-raced' },
      });
      expect(armed).toBe(false);
      expect(pointer(fixture)).toEqual({ build_id: B, generation: 3 });
      expect(events(fixture)).toHaveLength(3);
      expect(events(fixture)[2]).toMatchObject({ previous_build_id: C, build_id: B });
    });
  });

  it('preserves the real transition when metadata fails after a successful pointer update', async () => {
    await withHistory(async (fixture) => {
      const prepare = fixture.projection.prepare.bind(fixture.projection);
      fixture.projection.prepare = (query) => {
        const statement = prepare(query);
        if (/^UPDATE projected_builds\s+SET verified_at/.test(query)) {
          statement.run = async () => {
            throw new Error('activation metadata write failed');
          };
        }
        return statement;
      };
      await expect(fixture.target.rollback()).rejects.toMatchObject({
        code: 'LORE_E_REMOTE_DEPLOY',
        details: { pointerChanged: true },
      });
      expect(pointer(fixture)).toEqual({ build_id: A, generation: 3 });
      expect(events(fixture)[2]).toMatchObject({
        previous_build_id: C,
        build_id: A,
        generation: 3,
      });
    });
  });

  it('rolls back the pointer statement when its event cannot be inserted', async () => {
    await withHistory(async (fixture) => {
      const before = events(fixture);
      fixture.projection.raw.exec(
        "CREATE TRIGGER fail_history BEFORE INSERT ON activation_events BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
      );
      await expect(fixture.target.rollback()).rejects.toMatchObject({
        code: 'LORE_E_REMOTE_DEPLOY',
        details: { pointerChanged: false },
      });
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 2 });
      expect(events(fixture)).toEqual(before);
    });
  });

  it('does not invent a transition or generation for a remote no-op activation', async () => {
    await withHistory(async (fixture) => {
      const before = events(fixture);
      await fixture.target.activate(fixture.cReceipt);
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 2 });
      expect(events(fixture)).toEqual(before);
    });
  });

  it('records an honest legacy baseline and keeps explicit retained-ID rollback usable', async () => {
    await withHistory(async (fixture) => {
      legacy(fixture);
      await expect(fixture.target.rollback()).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 2 });
      expect(events(fixture)).toHaveLength(1);
      expect(events(fixture)[0]).toMatchObject({
        generation: 2,
        build_id: C,
        previous_build_id: null,
        kind: 'baseline',
      });
      fixture.projection.raw
        .prepare(
          'UPDATE projected_builds SET verified_at = NULL WHERE project_id = ? AND build_id = ?',
        )
        .run(PROJECT, A);
      expect((await fixture.target.rollback(A)).buildId).toBe(A);
      expect((await fixture.target.rollback()).buildId).toBe(C);
      expect(events(fixture)).toHaveLength(3);
    });
  });

  it('records a migration-time activation before baseline selection without fabricating history', async () => {
    await withHistory(async (fixture) => {
      legacy(fixture);
      const prepare = fixture.projection.prepare.bind(fixture.projection);
      fixture.projection.prepare = (query) => {
        const statement = prepare(query);
        const execute = statement.run.bind(statement);
        statement.run = async <T = Record<string, unknown>>() => {
          const result = await execute<T>();
          if (query.startsWith('CREATE TRIGGER IF NOT EXISTS record_activation')) {
            fixture.projection.raw
              .prepare(
                'UPDATE active_build SET build_id = ?, generation = generation + 1 WHERE id = 1',
              )
              .run(B);
          }
          return result;
        };
        return statement;
      };
      expect((await fixture.target.rollback()).buildId).toBe(C);
      expect(
        events(fixture).map((row) => [
          row.generation,
          row.kind,
          row.previous_build_id,
          row.build_id,
        ]),
      ).toEqual([
        [3, 'transition', C, B],
        [4, 'transition', B, C],
      ]);
    });
  });

  it('retries a partial migration without overwriting a transition recorded before retry', async () => {
    await withHistory(async (fixture) => {
      legacy(fixture);
      const prepare = fixture.projection.prepare.bind(fixture.projection);
      let fail = true;
      fixture.projection.prepare = (query) => {
        const statement = prepare(query);
        if (fail && query.startsWith('INSERT OR IGNORE INTO activation_events')) {
          statement.run = async () => {
            fail = false;
            throw new Error('baseline write failed');
          };
        }
        return statement;
      };
      await expect(fixture.target.rollback()).rejects.toThrow('baseline write failed');
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 2 });
      fixture.projection.raw
        .prepare('UPDATE active_build SET build_id = ?, generation = generation + 1 WHERE id = 1')
        .run(B);
      expect((await fixture.target.rollback()).buildId).toBe(C);
      expect(
        events(fixture).map((row) => [
          row.generation,
          row.kind,
          row.previous_build_id,
          row.build_id,
        ]),
      ).toEqual([
        [3, 'transition', C, B],
        [4, 'transition', B, C],
      ]);
    });
  });

  it('retains transition facts after real cleanup and refuses the pruned actual predecessor', async () => {
    await withHistory(async (fixture) => {
      const before = events(fixture);
      const plan = await planRemoteRetention(fixture.projection, fixture.projection, PROJECT, 0);
      const cleaned = await applyRemoteRetentionPlan(
        fixture.projection,
        fixture.projection,
        fixture.bucket,
        plan,
      );
      expect(cleaned.remove).toContain(A);
      expect(events(fixture)).toEqual(before);
      await expect(fixture.target.rollback()).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      expect(pointer(fixture)).toEqual({ build_id: C, generation: 2 });
      expect(
        (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
      ).toBe(C);
    });
  });
});

it('records atomic activation events using the actual migration SQL in local workerd D1', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-history-workerd-'));
  const workerRoot = join(import.meta.dirname, '..');
  const schema = join(root, 'history.sql');
  const wrangler = join(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
  const initial = PROJECTION_MIGRATIONS.find((migration) => migration.id === '0001');
  const history = PROJECTION_MIGRATIONS.find((migration) => migration.id === '0008');
  if (initial === undefined || history === undefined)
    throw new Error('Production history migrations are missing.');
  const sql = (text: string, successful = true) => {
    writeFileSync(schema, text);
    const result = spawnSync(
      process.execPath,
      [
        wrangler,
        'd1',
        'execute',
        'CATALOG_DB',
        '--local',
        '--config',
        join(workerRoot, 'wrangler.jsonc'),
        '--persist-to',
        root,
        '--file',
        schema,
        '--json',
      ],
      {
        cwd: workerRoot,
        encoding: 'utf8',
        env: { ...process.env, NO_D1_WARNING: 'true' },
        timeout: 30_000,
      },
    );
    if (successful) expect(result.status, result.stderr || String(result.error ?? '')).toBe(0);
    return result;
  };
  try {
    sql(
      [
        ...initial.statements.slice(0, 2),
        `UPDATE active_build SET build_id = '${A}', generation = 1 WHERE id = 1`,
        ...history.statements,
        `UPDATE active_build SET build_id = '${C}', generation = 2 WHERE id = 1`,
        `UPDATE active_build SET build_id = '${C}', generation = 2 WHERE id = 1`,
      ].join(';\n'),
    );
    const inspect = () => {
      const result = sql(
        'SELECT build_id, generation FROM active_build WHERE id = 1; SELECT generation, previous_build_id, build_id, kind FROM activation_events ORDER BY generation;',
      );
      const frames = JSON.parse(result.stdout) as { results: Record<string, unknown>[] }[];
      return frames.map((frame) => frame.results);
    };
    const before = inspect();
    expect(before[0]).toEqual([{ build_id: C, generation: 2 }]);
    expect(before[1]).toEqual([
      { generation: 1, previous_build_id: null, build_id: A, kind: 'baseline' },
      { generation: 2, previous_build_id: A, build_id: C, kind: 'transition' },
    ]);
    sql(
      "CREATE TRIGGER fail_history BEFORE INSERT ON activation_events BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
    );
    const failed = sql(
      `UPDATE active_build SET build_id = '${A}', generation = 3 WHERE id = 1`,
      false,
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr + failed.stdout).toContain('event write failed');
    expect(inspect()).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
