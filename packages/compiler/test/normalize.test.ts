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

async function parseMarkdown(markdown: string, relativePath = 'a.md') {
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

async function parseCode(source: string, relativePath = 'a.ts') {
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
    const parsed = await parseMarkdown('# Title\n\nFirst paragraph.\n\n## Section\n\nSecond.\n');
    const result = await normalizeArtifact({ parsed, objects });

    const body = objects.text(result.objectHash);
    expect(body).toContain('# Title');
    expect(body).toContain('First paragraph.');
    expect(body).toContain('## Section');
    expect(body).toContain('Second.');
  });

  it('deduplicates identical bodies across artifacts', async () => {
    const objects = new FakeObjectStore();
    await normalizeArtifact({ parsed: await parseMarkdown('# A\n\nbody\n', 'one.md'), objects });
    await normalizeArtifact({ parsed: await parseMarkdown('# A\n\nbody\n', 'two.md'), objects });
    expect(objects.writes).toBe(1);
  });

  it('produces the same object hash for the same content on every run', async () => {
    const objects = new FakeObjectStore();
    const first = await normalizeArtifact({
      parsed: await parseMarkdown('# A\n\nbody\n'),
      objects,
    });
    const second = await normalizeArtifact({
      parsed: await parseMarkdown('# A\n\nbody\n'),
      objects,
    });
    expect(second.objectHash).toBe(first.objectHash);
  });

  it('leaves code text untouched in the stored body', async () => {
    const objects = new FakeObjectStore();
    const source = 'function a() {\n    return 1;\n}';
    const result = await normalizeArtifact({ parsed: await parseCode(source), objects });
    expect(objects.text(result.objectHash)).toContain('    return 1;');
  });

  it('updates the revision hash only for nodes whose text changed', async () => {
    const objects = new FakeObjectStore();
    const parsed = await parseMarkdown('# A\n\nspaced    out\n');
    const result = await normalizeArtifact({ parsed, objects });

    const before = new Map(parsed.nodes.map((node) => [node.id, node.revisionHash]));
    const changed = result.nodes.filter((node) => before.get(node.id) !== node.revisionHash);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toBe('spaced out');
  });

  it('renders headings into the body so a range stays readable alone', async () => {
    const parsed = await parseMarkdown('# Top\n\ntext\n\n## Sub\n\nmore\n');
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

  it('prefers whole nodes and prefixes the heading path', async () => {
    const parsed = await parseMarkdown('# Top\n\n## Section\n\nSome body text here.\n');
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks.find((c) => c.text.includes('Some body text here.'));
    expect(chunk?.headingPath).toEqual(['Top', 'Section']);
    expect(chunk?.text.startsWith('Top > Section')).toBe(true);
  });

  it('never joins content from two different sections', async () => {
    const parsed = await parseMarkdown('## A\n\nalpha\n\n## B\n\nbeta\n');
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    for (const chunk of chunks) {
      expect(chunk.text.includes('alpha') && chunk.text.includes('beta')).toBe(false);
    }
  });

  it('never exceeds the hard maximum', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} with words.`).join(
      ' ',
    );
    const parsed = await parseMarkdown(`# Big\n\n${long}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens, chunk.id).toBeLessThanOrEqual(chunking.maximumTokens);
    }
  });

  it('applies overlap only where a split happened', async () => {
    const parsed = await parseMarkdown('# A\n\nshort body\n');
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    expect(chunks).toHaveLength(1);
    // With no split there is nothing to overlap, so the text appears exactly once.
    expect(chunks[0]?.text.split('short body')).toHaveLength(2);
  });

  it('keeps every chunk inside one artifact with valid node references', async () => {
    const parsed = await parseMarkdown('# A\n\none\n\n## B\n\ntwo\n\n### C\n\nthree\n');
    const ids = new Set(parsed.nodes.map((node) => node.id));
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    for (const chunk of chunks) {
      expect(chunk.artifactId).toBe('src:a.md');
      expect(chunk.nodeIds.length).toBeGreaterThan(0);
      for (const nodeId of chunk.nodeIds) expect(ids.has(nodeId), nodeId).toBe(true);
      expect(chunk.locator.lineStart).toBeGreaterThan(0);
    }
  });

  it('resolves first-node locators with linear node-ID reads, issue788', async () => {
    const sections = 1024;
    const parsed = await parseMarkdown(
      Array.from(
        { length: sections },
        (_, index) => `## Section ${index}\n\nBody ${index}.\n`,
      ).join('\n'),
    );
    let idReads = 0;
    const nodes = parsed.nodes.map((node) => {
      const id = node.id;
      return {
        ...node,
        get id() {
          idReads += 1;
          return id;
        },
      };
    });
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes, chunking });

    expect(chunks).toHaveLength(sections);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(
      Array.from({ length: sections }, (_, index) => [`Section ${index}`]),
    );
    expect(chunks.every((chunk) => chunk.locator.relativePath === 'a.md')).toBe(true);
    expect(idReads).toBeLessThanOrEqual(nodes.length * 4);
  });

  it('retains the first matching locator when node IDs repeat, issue788', async () => {
    const parsed = await parseMarkdown('# First\n\none\n\n# Second\n\ntwo\n');
    const baseline = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    const firstId = baseline[0]?.nodeIds[0];
    const secondId = baseline[1]?.nodeIds[0];
    if (firstId === undefined || secondId === undefined) throw new Error('Fixture has no chunks.');
    const nodes = parsed.nodes.map((node) => {
      if (node.id === firstId)
        return { ...node, locator: { ...node.locator, relativePath: 'first.md' } };
      if (node.id === secondId)
        return { ...node, id: firstId, locator: { ...node.locator, relativePath: 'second.md' } };
      return node;
    });
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes, chunking });

    expect(chunks.map((chunk) => chunk.locator.relativePath)).toEqual(['first.md', 'first.md']);
    expect(chunks[1]?.headingPath).toEqual(['Second']);
    expect(chunks[1]?.text).toContain('two');
  });

  it('produces identical chunks on a repeated run', async () => {
    const parsed = await parseMarkdown('# A\n\none\n\n## B\n\ntwo\n');
    const first = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    const second = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('keeps chunk ids stable for sections before an edit', async () => {
    const before = await parseMarkdown('# A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree\n');
    const after = await parseMarkdown('# A\n\none\n\n## B\n\nEDITED\n\n## C\n\nthree\n');

    const chunksBefore = chunkArtifact({ artifactId: 'src:a.md', nodes: before.nodes, chunking });
    const chunksAfter = chunkArtifact({ artifactId: 'src:a.md', nodes: after.nodes, chunking });

    expect(chunksAfter.map((c) => c.id)).toEqual(chunksBefore.map((c) => c.id));
    const changed = chunksBefore.filter(
      (chunk, index) => chunk.revisionHash !== chunksAfter[index]?.revisionHash,
    );
    expect(changed).toHaveLength(1);
  });

  it('produces nothing for an empty document rather than an empty chunk', async () => {
    const parsed = await parseMarkdown('');
    expect(chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking })).toEqual([]);
  });

  it('splits a single oversized node with bounded overlap', async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    const parsed = await parseMarkdown(`# Big\n\n${huge}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(chunking.maximumTokens);
      // A split piece still belongs to the node it came from.
      expect(chunk.nodeIds).toHaveLength(1);
    }
  });

  it('never splits a surrogate pair, whatever the text and the budget (#591)', async () => {
    // Emoji and astral CJK are two UTF-16 code units each. A cut between them stores a lone
    // surrogate, which is not well-formed Unicode and is what a model would then be served.
    const alphabet = [
      'a',
      'bc',
      '\u00e9',
      '\u4e2d',
      '\u{1F600}',
      '\u{20000}',
      '\u{1F469}\u200D\u{1F4BB}',
    ];
    let seed = 591;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run += 1) {
      const length = 200 + Math.floor(random() * 4000);
      // Some runs have no spaces at all, so every boundary is a hard cut.
      const spacing = run % 4 === 0 ? 0 : random() * 0.2;
      let body = '';
      while (body.length < length) {
        body += random() < spacing ? ' ' : alphabet[Math.floor(random() * alphabet.length)];
      }
      const maximumTokens = 20 + Math.floor(random() * 200);
      const tight = {
        targetTokens: Math.floor(maximumTokens / 2),
        maximumTokens,
        overlapTokens: Math.floor(random() * maximumTokens),
      };
      const parsed = await parseMarkdown(`# Big\n\n${body}\n`);
      const chunks = chunkArtifact({
        artifactId: 'src:a.md',
        nodes: parsed.nodes,
        chunking: tight,
      });
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.text.isWellFormed(), chunk.text).toBe(true);
      // Overlap never stalls the split: each piece advances by at least a quarter of the
      // budget, so a large overlap cannot multiply the chunk count.
      const window = (maximumTokens - estimateTokens('Big\n\n')) * 3.6;
      expect(chunks.length).toBeLessThanOrEqual(Math.ceil((4 * body.length) / window) + 2);
    }
  });

  it('keeps a run of emoji with no spaces well formed across hard cuts (#591)', async () => {
    const parsed = await parseMarkdown(`# Big\n\n${'\u{1F600}'.repeat(6001)}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.isWellFormed()).toBe(true);
  });

  it('shares the configured overlap between adjacent split pieces (#591)', async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
    const parsed = await parseMarkdown(`# Big\n\n${huge}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    // A piece cut after a space ends with one, so empty strings are not words.
    const bodies = chunks.map((chunk) =>
      chunk.text
        .replace(/^Big\n\n/, '')
        .split(' ')
        .filter(Boolean),
    );
    expect(bodies.length).toBeGreaterThan(2);

    for (let index = 1; index < bodies.length; index += 1) {
      const previous = bodies[index - 1] as string[];
      const current = bodies[index] as string[];
      // The piece starts on a whole word the previous piece already carried.
      const first = current[0] as string;
      const at = previous.indexOf(first);
      expect(at, `piece ${index} starts with ${first}`).toBeGreaterThan(-1);
      const shared = previous.slice(at);
      expect(current.slice(0, shared.length)).toEqual(shared);
      const sharedTokens = estimateTokens(shared.join(' '));
      expect(sharedTokens).toBeLessThanOrEqual(chunking.overlapTokens);
      expect(sharedTokens).toBeGreaterThanOrEqual(chunking.overlapTokens * 0.8);
    }

    // Nothing is lost: every word appears, in order.
    const seen = new Set(bodies.flat());
    for (let i = 0; i < 3000; i += 1) expect(seen.has(`w${i}`), `w${i}`).toBe(true);
  });

  it('shares nothing when overlap is configured off (#591)', async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
    const parsed = await parseMarkdown(`# Big\n\n${huge}\n`);
    const none = { ...chunking, overlapTokens: 0 };
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking: none });
    const words = chunks.flatMap((chunk) =>
      chunk.text
        .replace(/^Big\n\n/, '')
        .split(' ')
        .filter(Boolean),
    );
    expect(words).toHaveLength(3000);
  });

  it('overlaps text with no spaces too, without breaking a character (#591)', async () => {
    const body = Array.from({ length: 6000 }, (_, i) => String.fromCodePoint(0x20000 + i)).join('');
    const parsed = await parseMarkdown(`# Big\n\n${body}\n`);
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking });
    const pieces = chunks.map((chunk) => chunk.text.replace(/^Big\n\n/, ''));
    expect(pieces.length).toBeGreaterThan(2);
    for (let index = 1; index < pieces.length; index += 1) {
      const head = [...(pieces[index] as string)].slice(0, 5).join('');
      expect(pieces[index - 1]).toContain(head);
    }
  });

  it('respects a custom chunking configuration', async () => {
    const parsed = await parseMarkdown(`# A\n\n${'word '.repeat(300)}\n`);
    const tight = { targetTokens: 50, maximumTokens: 80, overlapTokens: 10 };
    const chunks = chunkArtifact({ artifactId: 'src:a.md', nodes: parsed.nodes, chunking: tight });
    for (const chunk of chunks) expect(chunk.estimatedTokens).toBeLessThanOrEqual(80);
    expect(chunks.length).toBeGreaterThan(3);
  });
});
