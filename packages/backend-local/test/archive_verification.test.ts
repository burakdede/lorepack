import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyCompiledFixture } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCatalogFiles } from '../src/archive-verification.js';
import { validBuild } from './archive_fixture.js';

const PACKAGE = join(import.meta.dirname, '..');
const COMPILED = join(PACKAGE, 'dist', 'archive-verification.js');
let directory: string;
let layout: string;
let copied: string;
let original: Map<string, Buffer>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lorepack-archive-parent-'));
  original = new Map();
  for (const [name, bytes] of validBuild(directory)) {
    const relative = name.replace('reports/', '');
    writeFileSync(join(directory, relative), bytes);
    original.set(relative, Buffer.from(bytes));
  }
  layout = mkdtempSync(join(PACKAGE, 'dist', '.archive-parent-'));
  mkdirSync(join(layout, 'module'));
  copied = join(layout, 'module', 'archive-verification.js');
  copyCompiledFixture(COMPILED, copied);
});

afterEach(() => {
  try {
    for (const [name, bytes] of original)
      expect(readFileSync(join(directory, name))).toEqual(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    rmSync(layout, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function copiedVerifier() {
  return (await import(
    pathToFileURL(copied).href
  )) as typeof import('../src/archive-verification.js');
}

function child(source: string): void {
  writeFileSync(join(layout, 'module', 'archive-verify-child.js'), source);
}

describe('archive verification parent process boundary', () => {
  it('returns the real child proof without modifying retained catalog bytes', async () => {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    expect(await verifyCatalogFiles(directory)).toEqual({
      buildId: manifest.buildId,
      canonicalRoots: manifest.canonicalRoots,
      objectHashes: [],
    });
  });

  it('reports an already-cancelled verification without accepting the package', async () => {
    await expect(verifyCatalogFiles(directory, AbortSignal.abort())).rejects.toMatchObject({
      code: 'LORE_E_CANCELLED',
      message: 'Catalog verification was cancelled.',
      remediation: 'Retained build data and the active pointer were not changed.',
    });
  });

  it('keeps the typed reinstall advice when both helper locations are missing', async () => {
    const verifier = await copiedVerifier();
    await expect(verifier.verifyCatalogFiles(directory)).rejects.toMatchObject({
      code: 'LORE_E_INTERNAL',
      message: 'The archive verifier is missing from this install.',
      remediation: 'Reinstall Lorepack or run pnpm build in a checkout.',
    });
  });

  it.each([
    { name: 'a failed helper', source: 'process.exitCode = 1;' },
    { name: 'invalid JSON from a helper', source: "process.stdout.write('{');" },
  ])('refuses $name instead of accepting retained data', async ({ source }) => {
    child(source);
    const verifier = await copiedVerifier();
    await expect(verifier.verifyCatalogFiles(directory)).rejects.toMatchObject({
      code: 'LORE_E_LIMIT_EXCEEDED',
      subject: 'context.sqlite',
      message: 'The archive verifier exceeded its execution limits or could not finish.',
    });
  });

  it.each([{ ok: false }, { ok: true }])(
    'refuses a helper reply without a logical proof: %j',
    async (reply) => {
      child(`process.stdout.write(${JSON.stringify(JSON.stringify(reply))});`);
      const verifier = await copiedVerifier();
      const error = await verifier.verifyCatalogFiles(directory).catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
        message: 'Logical package verification failed.',
        remediation: 'Restore or rebuild the package with a compatible Lorepack version.',
      });
      expect(error).toHaveProperty('subject', undefined);
      expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty('subject');
    },
  );
});
