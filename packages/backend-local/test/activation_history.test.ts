import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BuildId, BuildSummary } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { openWritable } from '../src/sqlite.js';
import { LocalStateStore } from '../src/state-store.js';

const MIGRATIONS = join(import.meta.dirname, '../migrations/state');
const A = `lore_${'a'.repeat(64)}` as BuildId;
const B = `lore_${'b'.repeat(64)}` as BuildId;

function summary(buildId: BuildId): BuildSummary {
  return {
    buildId,
    state: 'verified',
    createdAt: '2026-01-01T00:00:00.000Z',
    counts: { artifacts: 0, nodes: 0, chunks: 0, tables: 0, tableRows: 0 },
  };
}

function events(lore: string) {
  const db = new DatabaseSync(join(lore, 'state.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM activation_events ORDER BY generation').all();
  } finally {
    db.close();
  }
}

describe('persistent activation history', () => {
  it('records actual transitions across no-op generation gaps, reopen and prune', async () => {
    await withTempProject({}, (temp) => {
      const lore = temp.path('.lore');
      const state = LocalStateStore.open(lore, MIGRATIONS);
      try {
        state.recordBuild(summary(A));
        state.recordBuild(summary(B));
        expect(state.activate(A)).toBe(1);
        expect(state.activate(A)).toBe(2);
        expect(events(lore)).toEqual([
          {
            generation: 1,
            previous_build_id: null,
            build_id: A,
            kind: 'transition',
            recorded_at: expect.any(String),
          },
        ]);
        expect(state.activate(B)).toBe(3);
        state.forgetBuild(A);
      } finally {
        state.close();
      }
      const reopened = LocalStateStore.open(lore, MIGRATIONS);
      try {
        expect(reopened.current()).toEqual({ buildId: B, generation: 3 });
        expect(reopened.getBuild(A)).toBeNull();
        expect(events(lore)).toEqual([
          {
            generation: 1,
            previous_build_id: null,
            build_id: A,
            kind: 'transition',
            recorded_at: expect.any(String),
          },
          {
            generation: 3,
            previous_build_id: A,
            build_id: B,
            kind: 'transition',
            recorded_at: expect.any(String),
          },
        ]);
      } finally {
        reopened.close();
      }
    });
  });

  it('observes an upgraded active pointer without inventing earlier transitions', async () => {
    await withTempProject({}, (temp) => {
      const lore = temp.path('.lore');
      mkdirSync(lore);
      const legacy = openWritable(join(lore, 'state.sqlite'));
      try {
        runMigrations(legacy, loadMigrations(MIGRATIONS).slice(0, 2));
        legacy
          .prepare("INSERT INTO builds (build_id, state, created_at) VALUES (?, 'active', ?)")
          .run(A, '2000-01-01T00:00:00.000Z');
        legacy
          .prepare(
            'UPDATE active_build SET build_id = ?, generation = 9, activated_at = ? WHERE id = 1',
          )
          .run(A, '2000-01-01T00:00:00.000Z');
      } finally {
        legacy.close();
      }
      const upgraded = LocalStateStore.open(lore, MIGRATIONS);
      try {
        expect(upgraded.current()).toEqual({ buildId: A, generation: 9 });
        expect(events(lore)).toEqual([
          {
            generation: 9,
            previous_build_id: null,
            build_id: A,
            kind: 'baseline',
            recorded_at: expect.any(String),
          },
        ]);
        expect(events(lore)[0]?.recorded_at).not.toBe('2000-01-01T00:00:00.000Z');
        upgraded.recordBuild(summary(B));
        expect(upgraded.activate(B)).toBe(10);
        expect(events(lore)[1]).toMatchObject({
          generation: 10,
          previous_build_id: A,
          build_id: B,
          kind: 'transition',
        });
      } finally {
        upgraded.close();
      }
      LocalStateStore.open(lore, MIGRATIONS).close();
      expect(events(lore)).toHaveLength(2);
    });
  });

  it('keeps pointer, generation, build states and history unchanged when event insertion fails', async () => {
    await withTempProject({}, (temp) => {
      const lore = temp.path('.lore');
      const state = LocalStateStore.open(lore, MIGRATIONS);
      try {
        state.recordBuild(summary(A));
        state.recordBuild(summary(B));
        state.activate(A);
        const before = events(lore);
        const fault = openWritable(join(lore, 'state.sqlite'));
        try {
          fault.exec(
            "CREATE TRIGGER fail_history BEFORE INSERT ON activation_events BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
          );
        } finally {
          fault.close();
        }
        expect(() => state.activate(B)).toThrow();
        expect(state.current()).toEqual({ buildId: A, generation: 1 });
        expect(state.getBuild(A)?.state).toBe('active');
        expect(state.getBuild(B)?.state).toBe('verified');
        expect(events(lore)).toEqual(before);
      } finally {
        state.close();
      }
    });
  });
  it('bounds displayed history while retaining the actual latest transition', async () => {
    await withTempProject({}, (temp) => {
      const state = LocalStateStore.open(temp.path('.lore'), MIGRATIONS);
      try {
        state.recordBuild(summary(A));
        state.recordBuild(summary(B));
        for (let index = 0; index < 55; index++) state.activate(index % 2 === 0 ? A : B);
        const history = state.history();
        expect(history.active).toEqual({ buildId: A, generation: 55 });
        expect(history.historyTruncated).toBe(true);
        expect(history.activationHistory).toHaveLength(50);
        expect(history.activationHistory.map((event) => event.generation)).toEqual(
          Array.from({ length: 50 }, (_, index) => 55 - index),
        );
        expect(history.activationHistory[0]).toMatchObject({ buildId: A, previousBuildId: B });
      } finally {
        state.close();
      }
    });
  });

  it('holds a consistent read snapshot until a competing writer can commit', async () => {
    await withTempProject({}, (temp) => {
      const lore = temp.path('.lore');
      const state = LocalStateStore.open(lore, MIGRATIONS);
      let peer: LocalStateStore | undefined;
      try {
        state.recordBuild(summary(A));
        state.recordBuild(summary(B));
        state.activate(A);
        const competitor = LocalStateStore.open(lore, MIGRATIONS);
        peer = competitor;
        const list = state.listBuilds.bind(state);
        const checkpoint = vi.spyOn(state, 'listBuilds').mockImplementationOnce(() => {
          expect(() => competitor.activate(B)).toThrowError(
            expect.objectContaining({
              code: 'LORE_E_INTERNAL',
              cause: expect.objectContaining({ errcode: 5 }),
            }),
          );
          return list();
        });
        let history: ReturnType<LocalStateStore['history']>;
        try {
          history = state.history();
        } finally {
          checkpoint.mockRestore();
        }
        expect(history.active).toEqual({ buildId: A, generation: 1 });
        expect(history.builds.find((build) => build.buildId === A)?.state).toBe('active');
        expect(history.builds.find((build) => build.buildId === B)?.state).toBe('verified');
        expect(history.activationHistory).toHaveLength(1);
        expect(history.activationHistory[0]).toMatchObject({ buildId: A, generation: 1 });
        expect(state.current()).toEqual({ buildId: A, generation: 1 });
        expect(competitor.activate(B)).toBe(2);
        expect(state.current()).toEqual({ buildId: B, generation: 2 });
      } finally {
        peer?.close();
        state.close();
      }
    });
  });
});
