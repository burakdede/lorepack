import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@lorepack/core';
import { checkDeterminism, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover/discover.js';

function inspect(root: string) {
  return discover({ config: loadConfig({ cwd: root }) });
}

const DOCS = {
  'docs/public/p.md': '# Public\n\nPublic narwhal.\n',
  'docs/private/p.md': '# Private\n\nPrivate walrus.\n',
};
const config = (sources: readonly string[]) =>
  `version: 1\nname: anchored\nsources: ${JSON.stringify(sources)}\n`;
const ids = (root: string) => inspect(root).artifacts.map((artifact) => artifact.artifactId);

describe('project-root ignore anchoring, issue588', () => {
  it('anchors a directory rule to the project even when its source is docs', async () => {
    await withTempProject(
      { files: { ...DOCS, 'lore.yaml': config(['docs']), '.loreignore': '/docs/private/\n' } },
      (project) => {
        expect(ids(project.root)).toEqual(['docs:public/p.md']);
      },
    );
  });

  it('does not reinterpret a project-root directory as a directory within each source', async () => {
    await withTempProject(
      { files: { ...DOCS, 'lore.yaml': config(['docs']), '.loreignore': '/private/\n' } },
      (project) => {
        expect(ids(project.root)).toEqual(['docs:private/p.md', 'docs:public/p.md']);
      },
    );
  });

  it('keeps slash-free rules effective at every depth', async () => {
    await withTempProject(
      { files: { ...DOCS, 'lore.yaml': config(['docs']), '.loreignore': 'private/\n' } },
      (project) => {
        expect(ids(project.root)).toEqual(['docs:public/p.md']);
      },
    );
  });

  it('does not apply an anchored docs rule to an equal name in another source', async () => {
    await withTempProject(
      {
        files: {
          ...DOCS,
          'notes/private/p.md': '# Notes\n',
          'lore.yaml': config(['docs', 'notes']),
          '.loreignore': '/docs/private/\n',
        },
      },
      (project) => {
        expect(ids(project.root)).toEqual(['docs:public/p.md', 'notes:private/p.md']);
      },
    );
  });

  it('matches a single-file source using its full declared project path', async () => {
    await withTempProject(
      {
        files: {
          ...DOCS,
          'lore.yaml': config(['docs/private/p.md', 'docs/public/p.md']),
          '.loreignore': '/docs/private/p.md\n',
        },
      },
      (project) => {
        const result = inspect(project.root);
        expect(result.artifacts.map((artifact) => artifact.displayPath)).toEqual([
          'docs/public/p.md',
        ]);
        expect(result.artifacts[0]?.relativePath).toBe('p.md');
      },
    );
  });

  it('keeps project-relative contents negations reachable', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': config(['docs']),
          '.loreignore': '/docs/drafts/**\n!/docs/drafts/keep.md\n',
          'docs/drafts/drop.md': '# Drop\n',
          'docs/drafts/keep.md': '# Keep\n',
        },
      },
      (project) => {
        expect(ids(project.root)).toEqual(['docs:drafts/keep.md']);
      },
    );
  });

  it.each([['docs'], ['docs/nested'], ['docs/nested/keep.md']])(
    'does not let source %s bypass its excluded ancestor',
    async (source) => {
      await withTempProject(
        {
          files: {
            'lore.yaml': config([source, 'notes']),
            '.loreignore': '/docs/\n!/docs/nested/keep.md\n',
            'docs/nested/keep.md': '# Hidden by its parent\n',
            'notes/p.md': '# Visible\n',
          },
        },
        (project) => {
          expect(ids(project.root)).toEqual(['notes:p.md']);
        },
      );
    },
  );

  it('matches a declared linked directory rather than its target spelling', async () => {
    await withTempProject(
      {
        files: {
          ...DOCS,
          'lore.yaml': config(['alias']),
          '.loreignore': '/alias/private/\n',
        },
      },
      (project) => {
        symlinkSync(project.path('docs'), join(project.root, 'alias'), 'junction');
        expect(ids(project.root)).toEqual(['alias:public/p.md']);
      },
    );
  });

  it('retains source-relative identity for included artifacts', async () => {
    await withTempProject(
      { files: { ...DOCS, 'lore.yaml': config(['docs']), '.loreignore': '/other/\n' } },
      (project) => {
        const result = inspect(project.root);
        expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual([
          'private/p.md',
          'public/p.md',
        ]);
        expect(result.artifacts.map((artifact) => artifact.sourceId)).toEqual(['docs', 'docs']);
      },
    );
  });

  it('produces the same selected identities from different absolute roots', async () => {
    const report = await checkDeterminism({
      files: { ...DOCS, 'lore.yaml': config(['docs']), '.loreignore': '/docs/private/\n' },
      produce: (project) => ids(project.root).join('|'),
    });
    expect(report.message ?? '').toBe('');
  });
});
