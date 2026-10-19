import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus, RUNTIME_LIMITS } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import {
  inlineString,
  makePdf,
  makeXlsx,
  number,
  row,
  withTempProject,
} from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * `readSource` against a real build.
 *
 * The fixture is chosen so the normalized body and the source disagree about line numbers.
 * That divergence is the whole reason this capability resolves ranges through node records
 * instead of slicing the body: the Phase 1 audit measured source line 13 landing at line 7
 * of the normalized text, and a slice would have returned the wrong paragraph with a
 * perfectly plausible citation attached (#44).
 */

const CONFIG = 'version: 1\nname: reads\nsources:\n  - .\n';

/**
 * Blank runs on purpose. Normalization collapses them, so every line number below the
 * first gap differs between the source and the normalized body.
 */
const DOCUMENT = [
  '# Title',
  '',
  '',
  '',
  'First paragraph, which sits on source line 5.',
  '',
  '',
  '',
  '## Section',
  '',
  '',
  '',
  'Second paragraph, which sits on source line 13.',
  '',
];

const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/spaced.md': `${DOCUMENT.join('\n')}\n`,
  'notes/plain.txt': 'A plain note.\nSecond line of the note.\nThird line of the note.\n',
};

async function withRuntime<T>(
  body: (runtime: ReturnType<typeof createRuntime>, root: string) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: CORPUS }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: project.root });
    try {
      return await body(createRuntime(backend), project.root);
    } finally {
      backend.close();
    }
  });
}

async function withPdfRuntime<T>(
  body: (runtime: ReturnType<typeof createRuntime>) => Promise<T>,
): Promise<T> {
  return withTempProject(
    {
      files: {
        ...CORPUS,
        'contract.pdf': makePdf([
          { lines: ['Support contract', 'Response times are measured in business hours.'] },
          { lines: ['Escalation', 'A critical incident escalates after thirty minutes.'] },
        ]),
      },
    },
    async (project) => {
      await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        return await body(createRuntime(backend));
      } finally {
        backend.close();
      }
    },
  );
}

describe('a line range means source lines', () => {
  it('returns the text those source lines hold in the original file', async () => {
    await withRuntime(async (runtime, root) => {
      const result = await runtime.readSource({
        path: 'guides/spaced.md',
        lineStart: 13,
        lineEnd: 13,
      });

      const sourceLine = readFileSync(join(root, 'guides', 'spaced.md'), 'utf8').split('\n')[12];
      expect(sourceLine).toContain('Second paragraph');
      expect(result.text).toContain('Second paragraph');
      // The proof that a body slice would have been wrong: the same index into the
      // normalized text is a different line entirely.
      expect(result.text).not.toContain('First paragraph');
    });
  });

  it('proves the two numberings really do diverge, or the test above proves nothing', async () => {
    await withRuntime(async (runtime) => {
      const whole = await runtime.readSource({ path: 'guides/spaced.md' });
      const normalizedLines = whole.text.split('\n');
      const sourceIndexOfSecond = DOCUMENT.findIndex((line) => line.startsWith('Second paragraph'));
      const normalizedIndexOfSecond = normalizedLines.findIndex((line) =>
        line.startsWith('Second paragraph'),
      );

      expect(sourceIndexOfSecond).toBe(12);
      expect(normalizedIndexOfSecond).toBeGreaterThanOrEqual(0);
      expect(normalizedIndexOfSecond).not.toBe(sourceIndexOfSecond);
    });
  });

  it('echoes the locator back in source coordinates', async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.readSource({
        path: 'guides/spaced.md',
        lineStart: 13,
        lineEnd: 13,
      });

      expect(result.locator.relativePath).toBe('guides/spaced.md');
      expect(result.locator.lineStart).toBe(13);
      expect(result.locator.lineEnd).toBe(13);
      expect(result.locator.headingPath).toContain('Section');
    });
  });

  it('takes a paragraph a range only clips, because half a sentence is not a citation', async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.readSource({
        path: 'guides/spaced.md',
        lineStart: 12,
        lineEnd: 13,
      });
      expect(result.text).toContain('Second paragraph');
    });
  });
});

describe('sealed range boundaries', () => {
  it('reads a parent heading and nested section in document order after source removal', async () => {
    await withRuntime(async (runtime, root) => {
      rmSync(join(root, 'guides'), { recursive: true, force: true });
      const result = await runtime.readSource({
        path: 'guides/spaced.md',
        headingPath: ['Title'],
      });
      expect(result.text).toContain('First paragraph');
      expect(result.text).toContain('Second paragraph');
      expect(result.text.indexOf('First paragraph')).toBeLessThan(
        result.text.indexOf('Second paragraph'),
      );
      expect(result.locator).toMatchObject({
        relativePath: 'guides/spaced.md',
        headingPath: ['Title'],
        lineStart: 5,
        lineEnd: 13,
      });
      expect(result.truncated).toBe(false);
    });
  });

  it.each([
    {
      range: { lineStart: 13 },
      included: 'Second paragraph',
      excluded: 'First paragraph',
      start: 13,
      end: 13,
    },
    {
      range: { lineEnd: 5 },
      included: 'First paragraph',
      excluded: 'Second paragraph',
      start: 5,
      end: 5,
    },
  ])(
    'resolves the open-ended range $range from sealed nodes',
    async ({ range, included, excluded, start, end }) => {
      await withRuntime(async (runtime, root) => {
        rmSync(join(root, 'guides'), { recursive: true, force: true });
        const result = await runtime.readSource({ path: 'guides/spaced.md', ...range });
        expect(result.text).toContain(included);
        expect(result.text).not.toContain(excluded);
        expect(result.locator).toMatchObject({ lineStart: start, lineEnd: end });
      });
    },
  );

  it('does not invent heading provenance for a plain text range', async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.readSource({ path: 'notes/plain.txt', lineStart: 2 });
      expect(result.text).toContain('Second line of the note.');
      expect(result.locator.relativePath).toBe('notes/plain.txt');
      expect(result.locator.headingPath).toBeUndefined();
    });
  });

  it('explains how to read a PDF when a line range has no recorded coordinates', async () => {
    await withPdfRuntime(async (runtime) => {
      await expect(
        runtime.readSource({ path: 'contract.pdf', lineStart: 1 }),
      ).rejects.toMatchObject({
        code: 'LORE_E_INVALID_ARGUMENT',
        remediation: 'This artifact records no line numbers, so read it whole.',
      });
      const whole = await runtime.readSource({ path: 'contract.pdf' });
      expect(whole.text).toContain('Support contract');
      expect(whole.text).toContain('Escalation');
      expect(whole.locator.page).toBeUndefined();
    });
  });
});

describe('addressing', () => {
  it('accepts an artifact id as readily as a path', async () => {
    await withRuntime(async (runtime) => {
      const byPath = await runtime.readSource({ path: 'notes/plain.txt' });
      const byId = await runtime.readSource({ artifactId: byPath.locator.artifactId ?? '' });
      expect(byId.text).toBe(byPath.text);
    });
  });

  it('selects by heading path', async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.readSource({
        path: 'guides/spaced.md',
        headingPath: ['Title', 'Section'],
      });
      expect(result.text).toContain('Second paragraph');
      expect(result.text).not.toContain('First paragraph');
    });
  });

  it('names the valid bounds when a range matches nothing', async () => {
    await withRuntime(async (runtime) => {
      await expect(
        runtime.readSource({ path: 'guides/spaced.md', lineStart: 900, lineEnd: 999 }),
      ).rejects.toMatchObject({
        code: 'LORE_E_INVALID_ARGUMENT',
        remediation: expect.stringContaining('spans lines'),
      });
    });
  });

  it('refuses a backwards range rather than returning nothing', async () => {
    await withRuntime(async (runtime) => {
      await expect(
        runtime.readSource({ path: 'guides/spaced.md', lineStart: 10, lineEnd: 2 }),
      ).rejects.toMatchObject({ code: 'LORE_E_INVALID_ARGUMENT' });
    });
  });

  it('says pages are not available here rather than returning page one of a Markdown file', async () => {
    await withRuntime(async (runtime) => {
      await expect(runtime.readSource({ path: 'guides/spaced.md', page: 1 })).rejects.toMatchObject(
        {
          code: 'LORE_E_INVALID_ARGUMENT',
        },
      );
    });
  });

  it('reads the page a PDF citation names from the sealed build', async () => {
    await withPdfRuntime(async (runtime) => {
      const result = await runtime.readSource({ path: 'contract.pdf', page: 2 });
      expect(result.text).toContain('critical incident');
      expect(result.locator.page).toBe(2);
      expect(result.locator.lineStart).toBeUndefined();
      expect(result.locator.lineEnd).toBeUndefined();
    });
  });
});

describe('sealed spreadsheet coordinates', () => {
  it.each([false, true])(
    'retains precise coordinates without inventing a whole-workbook location (multiple sheets: %s)',
    async (multipleSheets) => {
      const orders = {
        name: 'Orders',
        rows:
          row(1, [inlineString('A1', 'Product'), inlineString('B1', 'Quantity')]) +
          row(2, [inlineString('A2', 'Notebook'), number('B2', 3)]) +
          row(3, [inlineString('A3', 'Pencil'), number('B3', 7)]),
      };
      const workbook = await makeXlsx({
        sheets: [
          orders,
          ...(multipleSheets
            ? [
                {
                  name: 'Budget',
                  rows:
                    row(1, [inlineString('A1', 'Team'), inlineString('B1', 'Amount')]) +
                    row(2, [inlineString('A2', 'Support'), number('B2', 120)]),
                },
              ]
            : []),
        ],
      });
      await withTempProject(
        { files: { 'lore.yaml': CONFIG, 'inventory.xlsx': workbook } },
        async (project) => {
          await runBuild({
            config: loadConfig({ cwd: project.root }),
            progress: new ProgressBus(),
          });
          rmSync(join(project.root, 'inventory.xlsx'));
          const backend = createLocalRuntimeBackend({ projectRoot: project.root });
          try {
            const runtime = createRuntime(backend);
            const whole = await runtime.readSource({ path: 'inventory.xlsx' });
            expect(whole.text).toContain('Notebook');
            expect(whole.locator.relativePath).toBe('inventory.xlsx');
            expect(whole.locator.lineStart).toBeUndefined();
            expect(whole.locator.lineEnd).toBeUndefined();
            if (multipleSheets) {
              expect(whole.text).toContain('Support');
              expect(whole.locator.sheet).toBeUndefined();
              expect(whole.locator.cellRange).toBeUndefined();
            } else {
              expect(whole.locator).toMatchObject({ sheet: 'Orders', cellRange: 'A1:B3' });
            }
            const selected = await runtime.readSource({
              path: 'inventory.xlsx',
              headingPath: ['Orders'],
            });
            expect(selected.text).toContain('Notebook');
            expect(selected.text).not.toContain('Support');
            expect(selected.locator).toMatchObject({
              relativePath: 'inventory.xlsx',
              headingPath: ['Orders'],
              sheet: 'Orders',
              cellRange: 'A1:B3',
            });
          } finally {
            backend.close();
          }
        },
      );
    },
  );
});

describe('the request never reaches a filesystem', () => {
  it.each([
    '../../../etc/passwd',
    '/etc/passwd',
    'guides/../../secret.md',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
  ])('refuses %s as an unknown artifact, not as a path', async (path) => {
    await withRuntime(async (runtime) => {
      await expect(runtime.readSource({ artifactId: path })).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
    });
  });
});

describe('self-sufficiency, architecture 11.2', () => {
  it('answers with every source file deleted', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      rmSync(join(project.root, 'guides'), { recursive: true, force: true });
      rmSync(join(project.root, 'notes'), { recursive: true, force: true });

      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const result = await createRuntime(backend).readSource({
          path: 'guides/spaced.md',
          lineStart: 13,
          lineEnd: 13,
        });
        expect(result.text).toContain('Second paragraph');
      } finally {
        backend.close();
      }
    });
  });
});

describe('truncation is explicit', () => {
  it('reports it rather than silently clipping a document', async () => {
    const long = `# Long\n\n${'word '.repeat(RUNTIME_LIMITS.maxSourceReadCharacters / 4)}\n`;
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'guides/long.md': long } },
      async (project) => {
        await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
        const backend = createLocalRuntimeBackend({ projectRoot: project.root });
        try {
          const result = await createRuntime(backend).readSource({ path: 'guides/long.md' });
          expect(result.truncated).toBe(true);
          expect(result.text.length).toBe(RUNTIME_LIMITS.maxSourceReadCharacters);
        } finally {
          backend.close();
        }
      },
    );
  });

  it('says so honestly when nothing was clipped', async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.readSource({ path: 'notes/plain.txt' });
      expect(result.truncated).toBe(false);
      expect(result.text).toContain('Third line of the note.');
    });
  });
});

describe('describeBuild', () => {
  it('reports when the build was created, which the manifest deliberately does not hold', async () => {
    await withRuntime(async (runtime) => {
      const described = await runtime.describeBuild();
      expect(described.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(described.counts.artifacts).toBe(2);
      expect(described.shortBuildId).toBe(described.buildId.slice(0, 17));
    });
  });

  it('keeps working after the sources are gone', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      writeFileSync(join(project.root, 'guides', 'spaced.md'), '', 'utf8');

      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        expect((await createRuntime(backend).describeBuild()).counts.artifacts).toBe(2);
      } finally {
        backend.close();
      }
    });
  });
});
