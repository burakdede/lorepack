import { hashBytes, type ParseInput, PRODUCT_DEFAULTS } from '@lorepack/core';
import { markdownParser, textParser } from '@lorepack/parsers';
import { describe, expect, it } from 'vitest';
import { chunkArtifact, estimateTokens } from '../src/chunk/chunk.js';
import {
  normalizeArtifact,
  normalizeText,
  renderBody,
  WHITESPACE_POLICY,
} from '../src/normalize/normalize.js';
import { FakeObjectStore } from './fake-object-store.js';

function parseMarkdown(markdown: string, relativePath = 'a.md') {
  const bytes = new TextEncoder().encode(markdown);
  const input: ParseInput = {
    artifactId: `src:${relativePath}`,
    sourceId: 'src',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/markdown',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return markdownParser.parse(input);
}

function parseCode(source: string, relativePath = 'a.ts') {
  const bytes = new TextEncoder().encode(source);
  return textParser.parse({
    artifactId: `src:${relativePath}`,
    sourceId: 'src',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/plain',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  });
}

describe('whitespace policy', () => {
  it('collapses runs inside prose, where it is invisible to a reader', () => {
    expect(normalizeText('one    two\t\tthree', 'paragraph')).toBe('one two three');
  });

  it('never touches code, where indentation is meaning', () => {
    const code = 'function a() {\n    if (x) {\n        return 1;\n    }\n}';
    expect(normalizeText(code, 'code')).toBe(code);
  });

  it('collapses excess blank lines in prose but not in code', () => {
    expect(normalizeText('a\n\n\n\nb', 'paragraph')).toBe('a\n\nb');
    expect(normalizeText('a\n\n\n\nb', 'code')).toBe('a\n\n\n\nb');
  });

  it('trims trailing whitespace in prose only', () => {
    expect(normalizeText('line   \nnext', 'paragraph')).toBe('line\nnext');
    expect(normalizeText('line   \nnext', 'code')).toBe('line   \nnext');
  });

  it('normalizes unicode to NFC so equivalent text hashes identically', () => {
    const decomposed = 'café';
    const composed = 'café';
    expect(normalizeText(decomposed, 'paragraph')).toBe(normalizeText(composed, 'paragraph'));
  });

  it('declares a policy for every node kind, so a new kind cannot be forgotten', () => {
    for (const kind of [
      'document',
      'section',
      'paragraph',
      'list',
      'code',
      'table',
      'sheet',
      'row-group',
    ] as const) {
      expect(WHITESPACE_POLICY[kind], kind).toBeDefined();
    }
  });
});

describe('normalized bodies', () => {
  it('stores a body that can answer a source read without the original file', async () => {
    const objects = new FakeObjectStore();
    const parsed = parseMarkdown('# Title\n\nFirst paragraph.\n\n## Section\n\nSecond.\n');
    const result = await normalizeArtifact({ parsed, objects });

    const body = objects.text(result.objectHash);
    expect(body).toContain('# Title');
    expect(body).toContain('First paragraph.');
    expect(body).toContain('## Section');
    expect(body).toContain('Second.');
  });

  it('deduplicates identical bodies across artifacts', async () => {
    const objects = new FakeObjectStore();
    await normalizeArtifact({ parsed: parseMarkdown('# A\n\nbody\n', 'one.md'), objects });
    await normalizeArtifact({ parsed: parseMarkdown('# A\n\nbody\n', 'two.md'), objects });
    expect(objects.writes).toBe(1);
  });

  it('produces the same object hash for the same content on every run', async () => {
    const objects = new FakeObjectStore();
    const first = await normalizeArtifact({ parsed: parseMarkdown('# A\n\nbody\n'), objects });
    const second = await normalizeArtifact({ parsed: parseMarkdown('# A\n\nbody\n'), objects });
    expect(second.objectHash).toBe(first.objectHash);
  });

  it('leaves code text untouched in the stored body', async () => {
    const objects = new FakeObjectStore();
    const source = 'function a() {\n    return 1;\n}';
    const result = await normalizeArtifact({ parsed: parseCode(source), objects });
    expect(objects.text(result.objectHash)).toContain('    return 1;');
  });

  it('updates the revision hash only for nodes whose text changed', async () => {
    const objects = new FakeObjectStore();
    const parsed = parseMarkdown('# A\n\nspaced    out\n');
    const result = await normalizeArtifact({ parsed, objects });

    const before = new Map(parsed.nodes.map((node) => [node.id, node.revisionHash]));
    const changed = result.nodes.filter((node) => before.get(node.id) !== node.revisionHash);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toBe('spaced out');
  });

  it('renders headings into the body so a range stays readable alone', () => {
    const parsed = parseMarkdown('# Top\n\ntext\n\n## Sub\n\nmore\n');
    const body = renderBody(parsed.nodes);
    expect(body.indexOf('# Top')).toBeLessThan(body.indexOf('text'));
    expect(body).toContain('## Sub');
  });
});

describe('token estimation', () => {
  it('is documented as an estimate and errs high rather than low', () => {
    // Budgeting is safer when the estimate over-counts: the failure mode is a smaller
    // bundle rather than an overflowing context window.
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(text.split(' ').length);
  });

  it('counts an empty string as nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is deterministic', () => {
    expect(estimateTokens('some text here')).toBe(estimateTokens('some text here'));
  });

  it('counts whitespace-heavy text by words rather than only by characters', () => {
    const sparse = Array.from({ length: 50 }, () => 'x').join('\n');
    expect(estimateTokens(sparse)).toBeGreaterThanOrEqual(50);
  });
});

describe('chunking', () => {
  const chunking = PRODUCT_DEFAULTS.chunking;

  it('prefers whole nodes and prefixes the heading path', () => {
    const parsed = parseMarkdown('# Top\n\n## Section\n\nSome body text here.\n');
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks.find((c) => c.text.includes('Some body text here.'));
    expect(chunk?.headingPath).toEqual(['Top', 'Section']);
    expect(chunk?.text.startsWith('Top > Section')).toBe(true);
  });

  it('never joins content from two different sections', () => {
    const parsed = parseMarkdown('## A\n\nalpha\n\n## B\n\nbeta\n');
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    for (const chunk of chunks) {
      expect(chunk.text.includes('alpha') && chunk.text.includes('beta')).toBe(false);
    }
  });

  it('never exceeds the hard maximum', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} with words.`).join(
      ' ',
    );
    const parsed = parseMarkdown(`# Big\n\n${long}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens, chunk.id).toBeLessThanOrEqual(chunking.maximumTokens);
    }
  });

  it('applies overlap only where a split happened', () => {
    const parsed = parseMarkdown('# A\n\nshort body\n');
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    expect(chunks).toHaveLength(1);
    // With no split there is nothing to overlap, so the text appears exactly once.
    expect(chunks[0]?.text.split('short body')).toHaveLength(2);
  });

  it('keeps every chunk inside one artifact with valid node references', () => {
    const parsed = parseMarkdown('# A\n\none\n\n## B\n\ntwo\n\n### C\n\nthree\n');
    const ids = new Set(parsed.nodes.map((node) => node.id));
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    for (const chunk of chunks) {
      expect(chunk.artifactId).toBe('src:a.md');
      expect(chunk.nodeIds.length).toBeGreaterThan(0);
      for (const nodeId of chunk.nodeIds) expect(ids.has(nodeId), nodeId).toBe(true);
      expect(chunk.locator.lineStart).toBeGreaterThan(0);
    }
  });

  it('produces identical chunks on a repeated run', () => {
    const parsed = parseMarkdown('# A\n\none\n\n## B\n\ntwo\n');
    const first = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    const second = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('keeps chunk ids stable for sections before an edit', () => {
    const before = parseMarkdown('# A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree\n');
    const after = parseMarkdown('# A\n\none\n\n## B\n\nEDITED\n\n## C\n\nthree\n');

    const chunksBefore = chunkArtifact({ artifactId: 'src:a.md', nodes: before.nodes, chunking });
    const chunksAfter = chunkArtifact({ artifactId: 'src:a.md', nodes: after.nodes, chunking });

    expect(chunksAfter.map((c) => c.id)).toEqual(chunksBefore.map((c) => c.id));
    const changed = chunksBefore.filter(
      (chunk, index) => chunk.revisionHash !== chunksAfter[index]?.revisionHash,
    );
    expect(changed).toHaveLength(1);
  });

  it('produces nothing for an empty document rather than an empty chunk', () => {
    const parsed = parseMarkdown('');
    expect(chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking })).toEqual([]);
  });

  it('splits a single oversized node with bounded overlap', () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    const parsed = parseMarkdown(`# Big\n\n${huge}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(chunking.maximumTokens);
      // A split piece still belongs to the node it came from.
      expect(chunk.nodeIds).toHaveLength(1);
    }
  });

  it('respects a custom chunking configuration', () => {
    const parsed = parseMarkdown(`# A\n\n${'word '.repeat(300)}\n`);
    const tight = { targetTokens: 50, maximumTokens: 80, overlapTokens: 10 };
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking: tight });
    for (const chunk of chunks) expect(chunk.estimatedTokens).toBeLessThanOrEqual(80);
    expect(chunks.length).toBeGreaterThan(3);
  });
});
