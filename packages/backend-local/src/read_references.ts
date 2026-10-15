import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  assertBuildId,
  type BuildId,
  LoreError,
  mkdirOwnerOnly,
  writeFileAtomic,
} from '@lorepack/core';
import { ProjectLock } from './lock.js';
import { ownProcessStart, processStart, sameProcessStart } from './process-start.js';

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ReadReference {
  readonly version: 1;
  readonly buildId: BuildId;
  readonly pid: number;
  readonly start: string;
  readonly hostname: string;
  readonly token: string;
}

export interface ProtectedReadBuild {
  readonly buildId: BuildId;
  readonly readers: number;
}

export function withReadReferenceLock<T>(
  loreDirectory: string,
  run: () => T | Promise<T>,
): Promise<T> {
  return new ProjectLock(join(loreDirectory, 'read-lock')).withLock(run);
}

// Registration and catalog acquisition share the cleanup guard. The record outlives it.
export function registerReadReference(loreDirectory: string, buildId: BuildId): () => void {
  const directory = join(loreDirectory, 'readers');
  mkdirOwnerOnly(directory);
  const token = randomUUID();
  const path = join(directory, `${token}.json`);
  const record: ReadReference = {
    version: 1,
    buildId,
    pid: process.pid,
    start: ownProcessStart(),
    hostname: hostname(),
    token,
  };
  writeFileAtomic(path, JSON.stringify(record), { ownerOnly: true });
  let released = false;
  return () => {
    if (released) return;
    rmSync(path, { force: true });
    released = true;
  };
}

export function protectedReadBuilds(loreDirectory: string, reclaim = false): ProtectedReadBuild[] {
  const directory = join(loreDirectory, 'readers');
  if (!existsSync(directory)) return [];
  const builds = new Map<BuildId, number>();
  const owners = new Map<number, { alive: boolean; start: string | null }>();
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.tmp-')) continue;
    const path = join(directory, name);
    const record = readReference(path, name);
    if (record === null) continue;
    let gone = false;
    if (record.hostname === hostname()) {
      if (!owners.has(record.pid)) {
        let alive = true;
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          alive = (error as { code?: string }).code !== 'ESRCH';
        }
        owners.set(record.pid, {
          alive,
          start: alive
            ? record.pid === process.pid
              ? ownProcessStart()
              : processStart(record.pid)
            : null,
        });
      }
      const owner = owners.get(record.pid);
      gone =
        owner?.alive === false ||
        (owner?.start !== null &&
          owner?.start !== undefined &&
          !sameProcessStart(record.start, owner.start));
    }
    if (gone) {
      if (reclaim) rmSync(path, { force: true });
      continue;
    }
    builds.set(record.buildId, (builds.get(record.buildId) ?? 0) + 1);
  }
  return [...builds].map(([buildId, readers]) => ({ buildId, readers }));
}

function readReference(path: string, name: string): ReadReference | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid reference file.');
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReadReference>;
    if (
      record === null ||
      typeof record !== 'object' ||
      Object.keys(record).sort().join(',') !== 'buildId,hostname,pid,start,token,version' ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid ?? 0) <= 0 ||
      (record.pid ?? 0) > 0x7fffffff ||
      typeof record.start !== 'string' ||
      record.start === '' ||
      typeof record.hostname !== 'string' ||
      record.hostname === '' ||
      typeof record.token !== 'string' ||
      !TOKEN.test(record.token) ||
      name !== `${record.token}.json` ||
      typeof record.buildId !== 'string'
    )
      throw new Error('Invalid reference record.');
    assertBuildId(record.buildId);
    return record as ReadReference;
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return null;
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'A retained reader ownership record cannot be verified.',
      {
        remediation:
          'Preserve retained data until the reader record is repaired or its owner is proven gone.',
        cause,
      },
    );
  }
}
