import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifestSchema, loadConfig, ProgressBus } from '@lorepack/core';
import {
  inlineString,
  makeDocx,
  makePdf,
  makeXlsx,
  number,
  paragraph,
  row,
  withTempProject,
} from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * Binary formats, driven through a real build rather than through their parsers.
 *
 * This file exists because #222 and #223 were both invisible from every parser test in the
 * repository. A parser test hands bytes to a parser; a build has stages in front of it, and
 * both defects lived there. `.docx` was excluded by fingerprinting before its parser ran, and
 * every warning a parser produced was dropped before the manifest was written.
 *
 * So the rule this file encodes: a new format is not done when its parser passes. It is done
 * when `runBuild` puts it in a build.
 */

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

async function fixtures(): Promise<Record<string, Uint8Array>> {
  return {
    // A NUL byte, which is what makes this test meaningful. Every real PDF has them in its
    // compressed streams; a pure-ASCII fixture passed even with #222 unfixed.
    'doc.pdf': makePdf([{ lines: ['Rollback restores the previous release.'] }], {
      title: 'Runbook',
      withNulByte: true,
    }),
    'doc.docx': await makeDocx({
      body: [paragraph('Runbook', 'Heading1'), paragraph('Rollback restores it.')].join(''),
    }),
    'book.xlsx': await makeXlsx({
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
  };
}

async function builtProject<T>(
  body: (root: string, result: Awaited<ReturnType<typeof runBuild>>) => Promise<T>,
): Promise<T> {
  const binary = await fixtures();
  return withTempProject(
    { files: { 'lore.yaml': CONFIG, 'readme.md': '# Notes\n\nSee the attachments.\n' } },
    async (temp) => {
      for (const [name, bytes] of Object.entries(binary)) {
        writeFileSync(join(temp.root, name), bytes);
      }
      const result = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      });
      return body(temp.root, result);
    },
  );
}

describe('a binary format reaches its parser', () => {
  it('puts the PDF, the DOCX and the workbook in the build', async () => {
    await builtProject(async (root, result) => {
      const manifest = buildManifestSchema.parse(
        JSON.parse(
          readFileSync(join(root, '.lore', 'builds', result.buildId, 'manifest.json'), 'utf8'),
        ),
      );

      // Four artifacts: the three binaries and the Markdown file. Before #222 was fixed this
      // was two, and the two that were missing were named "binary" in a warning.
      expect(result.counts.artifacts).toBe(4);
      expect(
        manifest.warnings.filter((warning) => warning.class === 'unsupported-file'),
      ).toHaveLength(0);
    });
  });

  /**
   * The specific regression. A NUL byte anywhere in the file used to be enough to exclude it,
   * and a PDF that contains one is a PDF, not a corrupt file.
   */
  it('does not treat a NUL byte inside a PDF as a reason to exclude it', async () => {
    await builtProject(async (root, result) => {
      const bytes = readFileSync(join(root, 'doc.pdf'));
      expect(bytes.includes(0)).toBe(true);
      expect(result.counts.artifacts).toBe(4);
    });
  });

  it('imports the workbook as a typed table, so the whole path works end to end', async () => {
    await builtProject(async (_root, result) => {
      expect(result.counts.tables).toBe(1);
      expect(result.counts.tableRows).toBe(1);
    });
  });

  /**
   * The exemption is about decodability, not about identity, so a text file that is not
   * UTF-8 must still be excluded exactly as #165 established. Losing that would trade one
   * silent failure for another: a build that counts a file it cannot read leaves the project
   * permanently dirty.
   */
  it('still excludes a text file that is not valid UTF-8', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'ok.md': '# Fine\n' } }, async (temp) => {
      writeFileSync(join(temp.root, 'broken.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
      const result = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      });
      const manifest = buildManifestSchema.parse(
        JSON.parse(
          readFileSync(join(temp.root, '.lore', 'builds', result.buildId, 'manifest.json'), 'utf8'),
        ),
      );
      expect(result.counts.artifacts).toBe(1);
      expect(manifest.warnings.some((warning) => warning.path === 'broken.md')).toBe(true);
    });
  });
});

describe('a parser warning reaches the build', () => {
  /**
   * #223: the warnings were computed carefully and then thrown away. Several tickets state
   * the warning *as* the acceptance criterion, because it is what makes a decision honest
   * instead of silent.
   */
  it('records a warning the parser produced, with its path and the parser class', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          // A ragged row and a duplicate header: two decisions the CSV parser makes and has
          // to admit to.
          'data.csv': 'name,name,qty\na,b,1\nc,d\n',
        },
      },
      async (temp) => {
        const result = await runBuild({
          config: loadConfig({ cwd: temp.root }),
          progress: new ProgressBus(),
        });
        const manifest = buildManifestSchema.parse(
          JSON.parse(
            readFileSync(
              join(temp.root, '.lore', 'builds', result.buildId, 'manifest.json'),
              'utf8',
            ),
          ),
        );

        const codes = manifest.warnings.map((warning) => warning.code);
        expect(codes).toContain('csv-duplicate-header');
        expect(codes).toContain('csv-ragged-row');
        for (const warning of manifest.warnings) {
          expect(warning.path).toBe('data.csv');
          expect(warning.class).toBe('parser');
        }
        expect(result.warnings).toBe(manifest.warnings.length);
      },
    );
  });

  /**
   * A warning that appears only on a cold cache is worse than one that never appears: it
   * teaches a reader that silence means nothing.
   */
  it('reports the same warnings on a rebuild that hits the parse cache', async () => {
    await withTempProject(
      // A text file rather than a CSV, deliberately: a table-bearing parse is never written
      // to the cache at all, so a CSV would exercise the re-parse path and prove nothing
      // about a hit. An empty text file warns and is cached, which is the case that matters.
      { files: { 'lore.yaml': CONFIG, 'a.md': '# Kept\n', 'notes.txt': '' } },
      async (temp) => {
        const config = loadConfig({ cwd: temp.root });
        const first = await runBuild({ config, progress: new ProgressBus() });
        const second = await runBuild({ config, progress: new ProgressBus() });

        expect(first.warnings).toBeGreaterThan(0);
        expect(second.reusedArtifacts).toBeGreaterThan(0);
        expect(second.warnings).toBe(first.warnings);
        expect(second.buildId).toBe(first.buildId);
      },
    );
  });
});
