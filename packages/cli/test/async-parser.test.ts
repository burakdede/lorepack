import type { ArtifactParser, ParsedArtifact, ParseInput } from '@lorepack/core';
import { EXIT_CODES, exitCodeFor, LoreError, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The parser port allows a promise, and the build has to mean it.
 *
 * Phase 5 adds two formats that cannot be read synchronously: `pdfjs.getDocument()` resolves
 * a promise and `mammoth.convertToHtml()` is a thenable. Widening `ArtifactParser.parse` to
 * `ParsedArtifact | Promise<ParsedArtifact>` is a one-line change that the type checker
 * accepts in silence, which is exactly why it needs a behavioural test: the compiler is
 * equally happy with a build that forgets to await, and the failure that produces is a
 * promise stored where an artifact should be.
 *
 * These drive `runBuild` with an injected asynchronous parser, so what is under test is the
 * real parse loop rather than a restatement of it.
 */

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

/** Set per test, then returned by the mocked registry below. */
let injected: ArtifactParser | null = null;

vi.mock('@lorepack/parsers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorepack/parsers')>();
  return {
    ...actual,
    parserFor: (input: { mediaType: string; relativePath: string }) =>
      injected !== null && injected.supports(input) ? injected : actual.parserFor(input),
  };
});

const { runBuild } = await import('../src/services/build.js');

/** A parser that resolves on the next tick, which is the shape of every real async one. */
function asyncParser(behaviour: (input: ParseInput) => Promise<ParsedArtifact>): ArtifactParser {
  return {
    id: 'async-fake',
    version: '1.0.0',
    supports: (input) => input.relativePath.endsWith('.md'),
    parse: behaviour,
  };
}

function nodesFor(input: ParseInput, text: string): ParsedArtifact {
  return {
    artifact: {
      id: input.artifactId,
      sourceId: input.sourceId,
      relativePath: input.relativePath,
      displayPath: input.displayPath,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      contentHash: input.contentHash,
      parserId: 'async-fake',
      parserVersion: '1.0.0',
      title: 'Async',
      status: 'active',
      authority: 50,
      supersedes: [],
      metadata: {},
    },
    // A document plus a paragraph, because that is the shape a real parser emits and the
    // chunker skips `document` nodes deliberately: a whole file is not a passage.
    nodes: [
      {
        id: `${input.artifactId}#0`,
        artifactId: input.artifactId,
        kind: 'document',
        ordinal: 0,
        title: 'Async',
        locator: { artifactId: input.artifactId, relativePath: input.relativePath },
        metadata: {},
        revisionHash: 'a'.repeat(64),
      },
      {
        id: `${input.artifactId}#0.0`,
        artifactId: input.artifactId,
        parentId: `${input.artifactId}#0`,
        kind: 'paragraph',
        ordinal: 0,
        text,
        locator: {
          artifactId: input.artifactId,
          relativePath: input.relativePath,
          lineStart: 1,
          lineEnd: 1,
        },
        metadata: {},
        revisionHash: 'b'.repeat(64),
      },
    ],
    warnings: [],
  };
}

beforeEach(() => {
  injected = null;
});

describe('a parser that returns a promise', () => {
  it('is awaited, so its nodes reach the build rather than a pending promise', async () => {
    injected = asyncParser(async (input) => {
      // A real tick, not a resolved promise: an unawaited call would still be pending here.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return nodesFor(input, 'Text that only exists after the await.');
    });

    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (temp) => {
      const result = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      });

      // The count is the assertion. A promise assigned where a ParsedArtifact belongs would
      // have no nodes to index, and the build would seal an empty artifact rather than fail.
      expect(result.counts.artifacts).toBe(1);
      expect(result.counts.nodes).toBe(2);
      expect(result.counts.chunks).toBeGreaterThan(0);
    });
  });

  /**
   * The half that is easy to get wrong. `result = parser.parse(...)` inside a `try` catches
   * nothing when the parser is asynchronous: the promise is returned, the block exits, and
   * the rejection surfaces later as an unhandled rejection that kills the process instead of
   * failing one artifact with an actionable message.
   */
  it('fails the artifact through the normal error path when it rejects', async () => {
    injected = asyncParser(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('the document is not what it claims to be');
    });

    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (temp) => {
      const failure = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LoreError);
      const error = failure as LoreError;
      expect(error.code).toBe('LORE_E_PARSE_FAILED');
      // Architecture 6.9: the message names the file and says what to do about it.
      expect(error.message).toContain('a.md');
      expect(error.remediation).toContain('.loreignore');
      // The original reason is kept rather than replaced by a generic one.
      expect(String((error.cause as Error)?.message)).toContain('not what it claims to be');
    });
  });

  it('leaves the active build untouched when it rejects', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (temp) => {
      const config = loadConfig({ cwd: temp.root });
      const good = await runBuild({ config, progress: new ProgressBus() });

      injected = asyncParser(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('nope');
      });
      await runBuild({ config, progress: new ProgressBus() }).catch(() => undefined);

      // Invariant 4: a failed build can never corrupt the active version.
      const still = await runBuild({ config, progress: new ProgressBus() }).catch(() => undefined);
      expect(still).toBeUndefined();
      injected = null;
      const after = await runBuild({ config, progress: new ProgressBus() });
      expect(after.buildId).toBe(good.buildId);
    });
  });
});

/**
 * A parser's own classification survives the build's error handling (#242).
 *
 * `build.ts` used to wrap **everything** a parser threw as `LORE_E_PARSE_FAILED`, which is a
 * build integrity failure at exit 2. A parser raising `LORE_E_ENVELOPE_EXCEEDED`, a user
 * problem at exit 1, was therefore reported as the wrong kind of thing with the wrong exit
 * code. The parser had classified it correctly and the pipeline overrode it, so anything
 * branching on the stable code, which is the entire point of the taxonomy, was misled.
 */
describe('what a parser throws keeps the meaning the parser gave it', () => {
  it('passes a LoreError through with its own code and exit code', async () => {
    injected = asyncParser(async () => {
      throw new LoreError('LORE_E_ENVELOPE_EXCEEDED', 'a.md is past a limit this parser has.', {
        remediation: 'Split it.',
      });
    });

    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (temp) => {
      const failure = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      }).catch((error: unknown) => error);

      const error = failure as LoreError;
      expect(error.code).toBe('LORE_E_ENVELOPE_EXCEEDED');
      expect(exitCodeFor(error.code)).toBe(EXIT_CODES.USER);
      // The parser's own sentence and remediation, not a generic wrapper around them.
      expect(error.message).toBe('a.md is past a limit this parser has.');
      expect(error.remediation).toBe('Split it.');
    });
  });

  it('still calls anything else a parse failure, because that is what it is', async () => {
    injected = asyncParser(async () => {
      throw new TypeError('undefined is not a function');
    });

    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (temp) => {
      const failure = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      }).catch((error: unknown) => error);

      const error = failure as LoreError;
      // A parser throwing something that is not a LoreError is a genuine surprise, which is
      // exactly what this code means. Exit 2: the candidate failed, not the user.
      expect(error.code).toBe('LORE_E_PARSE_FAILED');
      expect(exitCodeFor(error.code)).toBe(EXIT_CODES.BUILD);
      expect(String((error.cause as Error)?.message)).toContain('not a function');
    });
  });
});
