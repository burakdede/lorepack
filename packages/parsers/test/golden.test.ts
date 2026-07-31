import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes, type ParseInput } from '@lorepack/core';
import { compareGolden } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { markdownParser } from '../src/markdown/parser.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Golden fixtures per architecture section 20.2: source, expected node tree, expected
 * locators, expected warnings, and the canonical hashes. Regenerate deliberately with
 * UPDATE_FIXTURES=1 and read the diff, since an unexplained change to expected output is
 * a defect rather than a formality.
 */
describe('markdown golden fixtures', () => {
  const name = 'product-strategy';
  const relativePath = `documents/markdown/${name}.md`;
  const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', relativePath)));

  const input: ParseInput = {
    artifactId: `fixtures:${relativePath}`,
    sourceId: 'fixtures',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/markdown',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };

  it('matches the committed expected output', () => {
    const parsed = markdownParser.parse(input);
    const result = compareGolden(
      join(REPO_ROOT, 'fixtures', 'expected', 'markdown', `${name}.json`),
      {
        artifact: parsed.artifact,
        nodes: parsed.nodes,
        warnings: parsed.warnings,
      },
    );
    expect(result.message ?? '', result.path).toBe('');
  });

  it('produces byte-identical output on a second parse', () => {
    const first = markdownParser.parse(input);
    const second = markdownParser.parse(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
