import { createHook } from 'node:async_hooks';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoreError } from '@lorepack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCatalogFiles } from '../src/archive-verification.js';
import { validBuild } from './archive_fixture.js';

let directory: string;
let original: Map<string, Buffer>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lorepack-cancelled-archive-'));
  original = new Map();
  for (const [name, bytes] of validBuild(directory)) {
    const relative = name.replace('reports/', '');
    writeFileSync(join(directory, relative), bytes);
    original.set(relative, Buffer.from(bytes));
  }
});

afterEach(() => {
  try {
    for (const [name, bytes] of original)
      expect(readFileSync(join(directory, name))).toEqual(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function processResources(operation: () => Promise<unknown>): Promise<readonly number[]> {
  const created: number[] = [];
  const hook = createHook({
    init(id, type) {
      if (type === 'PROCESSWRAP') created.push(id);
    },
  }).enable();
  try {
    await operation();
  } finally {
    hook.disable();
  }
  return created;
}

describe('archive verification cancelled before launch', () => {
  it.each([
    { name: 'default reason', signal: () => AbortSignal.abort() },
    { name: 'string reason', signal: () => AbortSignal.abort('fixture-cancellation-reason') },
    {
      name: 'typed reason',
      signal: () =>
        AbortSignal.abort(new LoreError('LORE_E_INTERNAL', 'fixture-cancellation-reason')),
    },
  ])('returns typed cancellation without creating a child for $name', async ({ signal }) => {
    const cancelled = signal();
    const created = await processResources(async () => {
      const error = await verifyCatalogFiles(directory, cancelled).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(LoreError);
      expect(error).toMatchObject({
        code: 'LORE_E_CANCELLED',
        message: 'Catalog verification was cancelled.',
        remediation: 'Retained build data and the active pointer were not changed.',
      });
      expect(JSON.stringify(error)).not.toContain('fixture-cancellation-reason');
    });
    expect(created).toHaveLength(0);
  });

  it('observes the real helper and its logical proof for a non-cancelled request', async () => {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    const created = await processResources(async () => {
      expect(await verifyCatalogFiles(directory)).toEqual({
        buildId: manifest.buildId,
        canonicalRoots: manifest.canonicalRoots,
        objectHashes: [],
      });
    });
    expect(created).toHaveLength(1);
  });
});
