import type { ArtifactParser, ParseInput } from '@lorepack/core';
import { LoreError, sha256Hex } from '@lorepack/core';
// The built package rather than `../src`: the host forks `parse-child.js` from beside its own
// module, and only the compiled output has one. `pnpm test` builds first.
import {
  csvParser,
  docxParser,
  htmlParser,
  markdownParser,
  type ParseLimits,
  ParserHost,
  parserFor,
  pdfParser,
  textParser,
  xlsxParser,
} from '@lorepack/parsers';
import {
  cmapBombPdf,
  docxBomb,
  flateBombPdf,
  inlineString,
  makeDocx,
  makeEncryptedPdf,
  makePdf,
  makeXlsx,
  nestedBracketsMarkdown,
  nestedListHtml,
  number,
  paragraph,
  row,
  singleCharacterCsv,
} from '@lorepack/test-support';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The parse isolation from #594, against the parsers themselves.
 *
 * The limits are set low so each hostile fixture exceeds them in a second rather than a
 * minute. The fixtures are the audit's table at a size a test can afford; the full-size
 * reproductions were run through a real `lorepack build` and recorded on the issue.
 */

const FAST: ParseLimits = { timeoutMs: 1_500, memoryMb: 256 };

/** Generous enough that only a pathological input reaches it, even on a slow runner. */
const SETTLE_MS = 10_000;

/**
 * Per test. Every case here starts Node and most drive a parser to a limit, so the package's
 * 5 s unit-test default is the wrong budget: a hosted runner took longer than that to reach a
 * 128 MB ceiling that a laptop reaches in two seconds.
 */
const SUITE = { timeout: 90_000 };

const hosts: ParserHost[] = [];
function host(limits?: ParseLimits): ParserHost {
  const created = new ParserHost(limits);
  hosts.push(created);
  return created;
}
afterEach(() => {
  for (const created of hosts.splice(0)) created.close();
});

function inputFor(relativePath: string, mediaType: string, bytes: Uint8Array): ParseInput {
  return {
    artifactId: `local:${relativePath}`,
    sourceId: 'local',
    relativePath,
    displayPath: relativePath,
    mediaType,
    byteSize: bytes.byteLength,
    contentHash: sha256Hex(bytes),
    bytes,
  };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function samples(): Promise<[ArtifactParser, ParseInput][]> {
  return [
    [
      markdownParser,
      inputFor(
        'a.md',
        'text/markdown',
        utf8(
          '---\ntitle: T\n---\n# One\n\nText with **bold** and a [link](x).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
        ),
      ),
    ],
    [textParser, inputFor('notes.txt', 'text/plain', utf8('First paragraph.\n\nSecond one.\n'))],
    [textParser, inputFor('code.ts', 'text/plain', utf8('export const a = 1;\n'))],
    [
      htmlParser,
      inputFor('page.html', 'text/html', utf8('<h1>Title</h1><p>Body <a href="/x">link</a></p>')),
    ],
    [
      pdfParser,
      inputFor('doc.pdf', 'application/pdf', makePdf([{ lines: ['Rollback restores it.'] }])),
    ],
    [
      docxParser,
      inputFor(
        'doc.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        await makeDocx({ body: [paragraph('Runbook', 'Heading1'), paragraph('Body.')].join('') }),
      ),
    ],
    [csvParser, inputFor('t.csv', 'text/csv', utf8('sku,qty\nA-1,5\nB-2,-0\n'))],
    [
      xlsxParser,
      inputFor(
        'book.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        await makeXlsx({
          sheets: [
            {
              name: 'Orders',
              rows: [
                row(1, [inlineString('A1', 'sku'), inlineString('B1', 'qty')]),
                row(2, [inlineString('A2', 'A-1'), number('B2', 5)]),
              ].join(''),
            },
          ],
        }),
      ),
    ],
  ];
}

describe('a parse in the child process', SUITE, () => {
  it('returns exactly what the parser returns in-process, for every format', async () => {
    const isolated = host();
    for (const [parser, input] of await samples()) {
      const direct = await parser.parse(input);
      const outcome = await isolated.parse(parser, input);
      expect(outcome.kind, input.relativePath).toBe('parsed');
      if (outcome.kind !== 'parsed') continue;
      // Strict: an `undefined` property, a `-0` or a key order lost on the way back would
      // change a canonical hash, and with it the build id.
      expect(outcome.result, input.relativePath).toStrictEqual(direct);
    }
  });

  it("keeps a parser's own LoreError, with its code, across the boundary", async () => {
    const outcome = isolatedFailure(
      host().parse(pdfParser, inputFor('locked.pdf', 'application/pdf', makeEncryptedPdf())),
    );
    const error = await outcome;
    expect(error).toBeInstanceOf(LoreError);
    expect(error).toMatchObject({ code: 'LORE_E_UNSUPPORTED_FORMAT', path: 'locked.pdf' });
    expect((error as LoreError).remediation).toContain('password');
  });

  it('runs a parser the child does not know in this process, as before', async () => {
    const own: ArtifactParser = {
      ...markdownParser,
      parse: (input) => markdownParser.parse(input),
    };
    const outcome = await host().parse(own, inputFor('a.md', 'text/markdown', utf8('# Hi\n')));
    expect(outcome.kind).toBe('parsed');
  });
});

describe('a parse that exceeds its limits, issue 594', SUITE, () => {
  const timeouts: [string, () => ParseInput][] = [
    [
      'Markdown of nested brackets',
      () => inputFor('brackets.md', 'text/markdown', nestedBracketsMarkdown(100_000)),
    ],
    ['HTML of nested lists', () => inputFor('list.html', 'text/html', nestedListHtml(50_000))],
    [
      'a PDF whose content stream inflates to 400 MB',
      () => inputFor('bomb.pdf', 'application/pdf', flateBombPdf(400)),
    ],
  ];

  for (const [name, input] of timeouts) {
    it(`stops ${name} at the deadline and names it a timeout`, async () => {
      const parsed = input();
      const parser = parserFor(parsed);
      expect(parser).not.toBeNull();
      const started = Date.now();
      const outcome = await host(FAST).parse(parser as ArtifactParser, parsed);
      expect(outcome).toMatchObject({ kind: 'excluded', code: 'parse-timeout' });
      expect(Date.now() - started).toBeLessThan(FAST.timeoutMs + SETTLE_MS);
    });
  }

  const memory: [string, () => Promise<ParseInput>][] = [
    [
      'a CSV of millions of one-character rows',
      async () => inputFor('rows.csv', 'text/csv', singleCharacterCsv(4_000_000)),
    ],
    [
      'a DOCX whose document inflates to 64 MB',
      async () =>
        inputFor(
          'bomb.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          await docxBomb(64),
        ),
    ],
    [
      // The fixture that rules out worker threads: V8 aborted the parent process on it.
      'a PDF whose ToUnicode CMap declares a 2^24 code range',
      async () => inputFor('cmap.pdf', 'application/pdf', cmapBombPdf(1)),
    ],
  ];

  for (const [name, input] of memory) {
    it(`stops ${name} at the memory ceiling, and this process survives`, async () => {
      const parsed = await input();
      const parser = parserFor(parsed) as ArtifactParser;
      const limits: ParseLimits = { timeoutMs: 60_000, memoryMb: 128 };
      const outcome = await host(limits).parse(parser, parsed);
      expect(outcome).toMatchObject({ kind: 'excluded', code: 'parse-memory' });
      if (outcome.kind === 'excluded') expect(outcome.message).toContain('128 MB');
    });
  }

  it('replaces a killed child, so the next file parses normally', async () => {
    const isolated = host(FAST);
    const slow = inputFor('brackets.md', 'text/markdown', nestedBracketsMarkdown(100_000));
    expect(await isolated.parse(markdownParser, slow)).toMatchObject({ code: 'parse-timeout' });

    const fine = await isolated.parse(
      markdownParser,
      inputFor('a.md', 'text/markdown', utf8('# A\n')),
    );
    expect(fine.kind).toBe('parsed');
  });

  it('stops promptly when the caller is cancelled mid-parse', async () => {
    const controller = new AbortController();
    const isolated = host({ timeoutMs: 60_000, memoryMb: 256 });
    // Warm the child first, so what is measured is the cancellation and not Node starting.
    await isolated.parse(markdownParser, inputFor('a.md', 'text/markdown', utf8('# A\n')));

    const slow = inputFor('brackets.md', 'text/markdown', nestedBracketsMarkdown(100_000));
    const pending = isolated.parse(markdownParser, slow, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    expect(await pending).toEqual({ kind: 'interrupted' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

async function isolatedFailure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('expected the parse to fail');
}
