import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const manifestPath = join(root, 'benchmarks/corpus/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  artifacts: Array<{ path: string; format: string; sha256: string; bytes: number }>;
  tiers: Record<string, { packs: number; artifacts: number }>;
};

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('mixed benchmark corpus manifest', () => {
  it('keeps every input checksum and byte count tied to the checked-in file', () => {
    for (const artifact of manifest.artifacts) {
      const path = join(root, artifact.path);
      expect(digest(path), artifact.path).toBe(artifact.sha256);
      expect(statSync(path).size, artifact.path).toBe(artifact.bytes);
    }
  });

  it('covers every v0.1 parser family and scales by whole packs', () => {
    expect(new Set(manifest.artifacts.map((artifact) => artifact.format))).toEqual(
      new Set(['markdown', 'text', 'html', 'pdf', 'docx', 'csv', 'xlsx', 'source-code']),
    );
    const packSize = manifest.artifacts.length;
    for (const tier of Object.values(manifest.tiers)) {
      expect(tier.artifacts).toBe(tier.packs * packSize);
    }
  });
});
