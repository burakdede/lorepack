import { EventEmitter } from 'node:events';
import { rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { discover } from '@lorepack/compiler';
import { type LoadedConfig, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import type { ChokidarOptions } from 'chokidar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readActiveBuild } from '../src/services/project.js';
import { resolveRealPath, startWatching } from '../src/services/watch.js';

const mocked = vi.hoisted(() => ({
  watch: vi.fn<(path: string, options: ChokidarOptions) => EventEmitter>(),
}));
vi.mock('chokidar', () => ({ watch: mocked.watch }));

beforeEach(() => {
  mocked.watch.mockReset();
  mocked.watch.mockImplementation(() => {
    const events = Object.assign(new EventEmitter(), {
      close: async () => {},
      getWatched: () => ({}),
    });
    queueMicrotask(() => events.emit('ready'));
    return events;
  });
});

const eventPath = (root: string, path: string): string => join(resolveRealPath(root), path);

const configuration = (sources: readonly string[]): string =>
  `version: 1\nname: source-watch\nsources:\n${sources.map((source) => `  - ${source}\n`).join('')}`;

function classification(config: LoadedConfig) {
  const watching = startWatching({
    config,
    warn: () => {},
    reconcileIntervalMs: 60_000,
    rebuild: async () => {
      throw new Error('Classification must not build.');
    },
  });
  const ignored = mocked.watch.mock.calls.at(-1)?.[1].ignored;
  if (typeof ignored !== 'function') throw new Error('Expected the actual ignored callback.');
  return { watching, ignored };
}

async function settled(until: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!until() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('source-relative reconciliation without filesystem events, issue587', () => {
  it.each([
    { sources: ['docs'], edited: 'docs/a.md' },
    { sources: ['docs', 'notes'], edited: 'notes/a.md' },
    { sources: ['docs/a.md'], edited: 'docs/a.md' },
  ])(
    'rebuilds $edited with sources $sources through the floor alone',
    async ({ sources, edited }) => {
      await withTempProject(
        {
          files: {
            'lore.yaml': configuration(sources),
            'docs/a.md': '# A\n\nOriginal content.\n',
            'notes/a.md': '# Notes\n\nIndependent content.\n',
          },
        },
        async (project) => {
          const config = loadConfig({ cwd: project.root });
          const first = await runBuild({ config, progress: new ProgressBus() });
          const warnings: string[] = [];
          const watching = startWatching({
            config,
            warn: (message) => warnings.push(message),
            debounceMs: 40,
            stabilityMs: 40,
            pollMs: 10,
            reconcileIntervalMs: 120,
            rebuild: () => runBuild({ config, progress: new ProgressBus() }),
          });
          try {
            await watching.ready;
            expect(watching.status().lastEventAt).toBeNull();
            project.write(edited, '# Updated\n\nA newly changed narwhal document.\n');
            await settled(() => watching.rebuilds > 0);
            expect(watching.rebuilds, warnings.join('')).toBe(1);
            expect(watching.status().lastEventAt).toBeNull();
            expect(readActiveBuild(project.path('.lore'))?.buildId).not.toBe(first.buildId);
            expect(await watching.freshness()).toBe('clean');
          } finally {
            await watching.close();
          }
        },
      );
    },
    60_000,
  );
});

describe('an empty source baseline, issue587', () => {
  it.each([
    { sources: ['docs'], original: 'docs/old.md', next: 'docs/new.md' },
    { sources: ['docs/old.md'], original: 'docs/old.md', next: 'docs/old.md' },
  ])(
    'notices the first restored artifact through the floor for $sources',
    async ({ sources, original, next }) => {
      await withTempProject(
        {
          files: {
            'lore.yaml': configuration(sources),
            [original]: '# Original\n\nThe original artifact.\n',
          },
        },
        async (project) => {
          const config = loadConfig({ cwd: project.root });
          const first = await runBuild({ config, progress: new ProgressBus() });
          rmSync(project.path(original));
          const watching = startWatching({
            config,
            warn: () => {},
            debounceMs: 40,
            stabilityMs: 40,
            pollMs: 10,
            reconcileIntervalMs: 120,
            rebuild: () => runBuild({ config, progress: new ProgressBus() }),
          });
          try {
            await watching.ready;
            const baseline = watching.rebuilds;
            expect(watching.status().lastEventAt).toBeNull();
            project.write(next, '# Restored\n\nThe restored walrus artifact.\n');
            await settled(() => watching.rebuilds > baseline);
            expect(watching.rebuilds).toBe(baseline + 1);
            expect(watching.status().lastEventAt).toBeNull();
            expect(readActiveBuild(project.path('.lore'))?.buildId).not.toBe(first.buildId);
            expect(await watching.freshness()).toBe('clean');
          } finally {
            await watching.close();
          }
        },
      );
    },
    60_000,
  );
});

describe('watch filtering agrees with discovery, issue587', () => {
  it.each([
    { sources: ['docs'], pattern: '/private/', path: 'docs/private/a.md' },
    { sources: ['docs'], pattern: '/docs/private/', path: 'docs/private/a.md' },
    { sources: ['docs', 'notes'], pattern: '/private/', path: 'notes/private/a.md' },
    { sources: ['docs/a.md'], pattern: '/a.md', path: 'docs/a.md' },
    { sources: ['docs/a.md'], pattern: '/docs/a.md', path: 'docs/a.md' },
    { sources: ['docs'], pattern: '/drafts/**\n!/drafts/keep.md', path: 'docs/drafts/drop.md' },
    { sources: ['docs'], pattern: '/drafts/**\n!/drafts/keep.md', path: 'docs/drafts/keep.md' },
  ])('$pattern for $path in $sources', async ({ sources, pattern, path }) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': configuration(sources),
          '.loreignore': `${pattern}\n`,
          'docs/a.md': '# A\n',
          'docs/private/a.md': '# Private\n',
          'notes/private/a.md': '# Notes private\n',
          'docs/drafts/drop.md': '# Drop\n',
          'docs/drafts/keep.md': '# Keep\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        const included = discover({ config }).artifacts.some(
          (artifact) =>
            resolveRealPath(artifact.absolutePath) === resolveRealPath(project.path(path)),
        );
        const { watching, ignored } = classification(config);
        try {
          expect(ignored(eventPath(project.root, path), statSync(project.path(path)))).toBe(
            !included,
          );
        } finally {
          await watching.close();
        }
      },
    );
  });

  it('keeps source ancestors and negated descendants reachable while pruning named directories', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': configuration(['docs/context']),
          '.loreignore': '/docs/\n/drafts/**\n!/drafts/keep.md\n/private/\n',
          'docs/context/drafts/keep.md': '# Keep\n',
          'docs/context/private/a.md': '# Private\n',
          '.lore/output.md': '# Build output\n',
        },
      },
      async (project) => {
        const { watching, ignored } = classification(loadConfig({ cwd: project.root }));
        try {
          for (const path of ['docs', 'docs/context', 'docs/context/drafts']) {
            expect(ignored(eventPath(project.root, path), statSync(project.path(path))), path).toBe(
              false,
            );
          }
          expect(
            ignored(
              eventPath(project.root, 'docs/context/private'),
              statSync(project.path('docs/context/private')),
            ),
          ).toBe(true);
          expect(
            ignored(
              eventPath(project.root, 'docs/context/drafts/keep.md'),
              statSync(project.path('docs/context/drafts/keep.md')),
            ),
          ).toBe(false);
          expect(ignored(eventPath(project.root, '.lore'), statSync(project.path('.lore')))).toBe(
            true,
          );
        } finally {
          await watching.close();
        }
      },
    );
  });

  it('maps both declared and real directory-source aliases to the same ignore rules', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': configuration(['alias']),
          '.loreignore': '/private/\n',
          'actual/private/a.md': '# Private\n',
          'actual/public.md': '# Public\n',
        },
      },
      async (project) => {
        symlinkSync(project.path('actual'), project.path('alias'), 'junction');
        const config = loadConfig({ cwd: project.root });
        const { watching, ignored } = classification(config);
        try {
          for (const root of [
            eventPath(project.root, 'alias'),
            resolveRealPath(project.path('alias')),
          ]) {
            expect(ignored(join(root, 'private/a.md'), statSync(join(root, 'private/a.md')))).toBe(
              true,
            );
            expect(ignored(join(root, 'public.md'), statSync(join(root, 'public.md')))).toBe(false);
          }
        } finally {
          await watching.close();
        }
      },
    );
  });
  it('waits for stat before applying a directory rule and ignores unrelated files', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': configuration(['docs']),
          '.loreignore': '/private/\n',
          'docs/private/a.md': '# Private\n',
          'other.md': '# Unconfigured\n',
        },
      },
      async (project) => {
        const { watching, ignored } = classification(loadConfig({ cwd: project.root }));
        try {
          const path = eventPath(project.root, 'docs/private');
          expect(ignored(path)).toBe(false);
          expect(ignored(path, statSync(path))).toBe(true);
          expect(ignored(eventPath(project.root, 'other.md'))).toBe(true);
        } finally {
          await watching.close();
        }
      },
    );
  });

  it('keeps file-source identity through a linked parent directory', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': configuration(['alias/a.md']),
          '.loreignore': '/a.md\n',
          'actual/a.md': '# Private\n',
          'actual/b.md': '# Unconfigured\n',
        },
      },
      async (project) => {
        symlinkSync(project.path('actual'), project.path('alias'), 'junction');
        const config = loadConfig({ cwd: project.root });
        expect(discover({ config }).artifacts).toEqual([]);
        const { watching, ignored } = classification(config);
        try {
          for (const root of [
            eventPath(project.root, 'alias'),
            resolveRealPath(project.path('alias')),
          ]) {
            expect(ignored(root, statSync(root))).toBe(false);
            expect(ignored(join(root, 'a.md'), statSync(join(root, 'a.md')))).toBe(true);
            expect(ignored(join(root, 'b.md'), statSync(join(root, 'b.md')))).toBe(true);
          }
        } finally {
          await watching.close();
        }
      },
    );
  });
});
