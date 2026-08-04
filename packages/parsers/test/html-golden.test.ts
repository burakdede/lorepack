import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes, type ParsedArtifact, type ParseInput } from '@lorepack/core';
import { checkDeterminism, compareGolden } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { htmlParser } from '../src/html/parser.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Golden fixtures per architecture section 20.2, on a page that carries every feature at once:
 * site chrome to drop, an article header to keep, nested headings, a list, a fenced code block,
 * a table with a head and a body, entities, and a link.
 *
 * The point of a golden file is the diff. An unexplained change to expected output is a defect
 * rather than a formality, which is why `UPDATE_FIXTURES=1` rewrites it and the review reads it.
 */
describe('html golden fixtures', () => {
  const name = 'documentation-page';
  const relativePath = `documents/html/${name}.html`;
  const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', relativePath)));

  const input: ParseInput = {
    artifactId: `fixtures:${relativePath}`,
    sourceId: 'fixtures',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/html',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };

  it('matches the committed expected output', () => {
    const parsed = htmlParser.parse(input) as ParsedArtifact;
    const result = compareGolden(join(REPO_ROOT, 'fixtures', 'expected', 'html', `${name}.json`), {
      artifact: parsed.artifact,
      nodes: parsed.nodes,
      warnings: parsed.warnings,
    });
    expect(result.message ?? '', result.path).toBe('');
  });

  it('produces byte-identical output on a second parse', () => {
    const first = htmlParser.parse(input);
    const second = htmlParser.parse(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  /**
   * Determinism across roots, which is the property that makes a build id portable. A parser
   * that leaked an absolute path into a node id or a locator would pass every test above and
   * fail this one.
   */
  it('produces the same nodes from two different absolute roots', async () => {
    const report = await checkDeterminism({
      files: { [relativePath]: readFileSync(join(REPO_ROOT, 'fixtures', relativePath), 'utf8') },
      produce: (project) => {
        const local = new Uint8Array(readFileSync(join(project.root, relativePath)));
        const parsed = htmlParser.parse({
          ...input,
          byteSize: local.byteLength,
          contentHash: hashBytes(local),
          bytes: local,
        }) as ParsedArtifact;
        return JSON.stringify({ nodes: parsed.nodes, warnings: parsed.warnings });
      },
    });
    expect(report.message ?? '').toBe('');
  });
});
