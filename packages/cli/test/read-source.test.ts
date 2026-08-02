import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus, RUNTIME_LIMITS } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
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
