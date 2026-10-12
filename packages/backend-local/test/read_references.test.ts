import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { BuildId } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { ownProcessStart } from '../src/process-start.js';
import {
  protectedReadBuilds,
  registerReadReference,
  withReadReferenceLock,
} from '../src/read_references.js';

const BUILD = `lore_${'a'.repeat(64)}` as BuildId;

function reference(lore: string, changes: Record<string, unknown> = {}) {
  const token = randomUUID();
  const directory = join(lore, 'readers');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${token}.json`);
  const record = {
    version: 1,
    buildId: BUILD,
    pid: process.pid,
    start: ownProcessStart(),
    hostname: hostname(),
    token,
    ...changes,
  };
  writeFileSync(path, JSON.stringify(record));
  return path;
}

describe('read reference ownership, issue 439', () => {
  it('protects every live acquired reference until its idempotent release', async () => {
    await withTempProject({}, async (project) => {
      const first = await withReadReferenceLock(project.root, () =>
        registerReadReference(project.root, BUILD),
      );
      const second = await withReadReferenceLock(project.root, () =>
        registerReadReference(project.root, BUILD),
      );
      expect(protectedReadBuilds(project.root, true)).toEqual([{ buildId: BUILD, readers: 2 }]);
      first();
      first();
      expect(protectedReadBuilds(project.root)).toEqual([{ buildId: BUILD, readers: 1 }]);
      second();
      expect(protectedReadBuilds(project.root, true)).toEqual([]);
      expect(readdirSync(join(project.root, 'readers'))).toEqual([]);
    });
  });

  it('reclaims a proven reused PID but never an unknown start identity', async () => {
    await withTempProject({}, async (project) => {
      const stale = reference(project.root, {
        start: ownProcessStart().startsWith('linux:') ? 'linux:0' : 'epoch:0',
      });
      const unknown = reference(project.root, { start: 'unavailable' });
      expect(protectedReadBuilds(project.root)).toEqual([{ buildId: BUILD, readers: 1 }]);
      expect(existsSync(stale)).toBe(true);
      expect(protectedReadBuilds(project.root, true)).toEqual([{ buildId: BUILD, readers: 1 }]);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(unknown)).toBe(true);
    });
  });

  it('preserves a foreign-host reference without interpreting its PID locally', async () => {
    await withTempProject({}, async (project) => {
      const path = reference(project.root, { hostname: `${hostname()}-other`, pid: 2_147_483_647 });
      expect(protectedReadBuilds(project.root, true)).toEqual([{ buildId: BUILD, readers: 1 }]);
      expect(existsSync(path)).toBe(true);
    });
  });

  it.each([
    { token: '../escape' },
    { pid: 9_007_199_254_740_991 },
    { buildId: '../../outside' },
    { version: 2 },
  ])('refuses malformed ownership without deleting its record: %j', async (changes) => {
    await withTempProject({}, async (project) => {
      const path = reference(project.root, changes);
      const before = readFileSync(path);
      expect(() => protectedReadBuilds(project.root, true)).toThrow(
        expect.objectContaining({ code: 'LORE_E_SCHEMA_MISMATCH' }),
      );
      expect(readFileSync(path)).toEqual(before);
    });
  });

  it('ignores unpublished atomic-write leftovers rather than treating them as acquired handles', async () => {
    await withTempProject({}, async (project) => {
      mkdirSync(join(project.root, 'readers'));
      writeFileSync(join(project.root, 'readers', '.tmp-interrupted'), '{');
      expect(protectedReadBuilds(project.root, true)).toEqual([]);
    });
  });
});
