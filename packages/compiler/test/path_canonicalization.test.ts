import { once } from 'node:events';
import { readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover/discover.js';
import { createMatcher, parseIgnoreFile } from '../src/discover/ignore.js';
import { resolveRules } from '../src/rules/resolve.js';

const CONFIG = 'version: 1\nname: paths\nsources: [.]\n';
const composed = 'café';
const decomposed = 'cafe\u0301';

describe('canonical path policy at discovery boundaries', () => {
  it('applies a decomposed ignore pattern to a canonical artifact path', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          '.loreignore': `${decomposed}-secret.md\n`,
          [`${composed}-secret.md`]: '# Hidden',
          'public.md': '# Public',
        },
      },
      ({ root }) => {
        const result = discover({ config: loadConfig({ cwd: root }) });
        expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual(['public.md']);
        expect(
          result.exclusions.some((entry) => entry.sample.includes(`${composed}-secret.md`)),
        ).toBe(true);
      },
    );
  });

  it('normalizes directory and negated patterns without changing case sensitivity', () => {
    const matcher = createMatcher(
      parseIgnoreFile(`${decomposed}/**\n!${decomposed}/keep.md\n`, '.loreignore'),
    );
    expect(matcher.excludes(`${composed}/drop.md`)).toBe(true);
    expect(matcher.excludes(`${composed}/keep.md`)).toBe(false);
    expect(matcher.excludes('CAFÉ/drop.md')).toBe(false);
    const directory = createMatcher(parseIgnoreFile(`${decomposed}/\n`, '.loreignore'));
    expect(directory.decideDirectory(composed)).not.toBeNull();
  });

  it('applies decomposed declared match globs to canonical paths', () => {
    const result = resolveRules({
      artifacts: [{ artifactId: `paths:${composed}.md`, relativePath: `${composed}.md` }],
      config: { rules: [{ match: `${decomposed}.md`, authority: 90 }], strictRules: true },
    });
    expect(result.resolved[0]).toMatchObject({ authority: 90, matchedRules: [0] });
    expect(result.warnings).toEqual([]);
  });

  it('resolves decomposed supersedes globs to existing canonical identities', () => {
    const result = resolveRules({
      artifacts: [
        { artifactId: 'paths:current.md', relativePath: 'current.md' },
        { artifactId: `paths:${composed}.md`, relativePath: `${composed}.md` },
      ],
      config: {
        rules: [{ match: 'current.md', supersedes: [`${decomposed}.md`] }],
        strictRules: true,
      },
    });
    expect(
      result.resolved.find((entry) => entry.relativePath === 'current.md')?.supersedes,
    ).toEqual([`paths:${composed}.md`]);
  });

  it('discovers ordinary dot-dot file and directory names', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          '..notes.md': '# Notes',
          '..archive/old.md': '# Old',
          'a.md': '# A',
        },
      },
      ({ root }) => {
        const result = discover({ config: loadConfig({ cwd: root }) });
        expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual([
          '..archive/old.md',
          '..notes.md',
          'a.md',
        ]);
        expect(result.warnings).toEqual([]);
      },
    );
  });

  // Unix-domain socket files are filesystem entries on POSIX; Windows named pipes are not.
  it.skipIf(process.platform === 'win32')(
    'reports a skipped filesystem socket without opening it',
    async () => {
      await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async ({ root }) => {
        const server = createServer();
        server.listen(join(root, 'channel.sock'));
        await once(server, 'listening');
        try {
          const result = discover({ config: loadConfig({ cwd: root }) });
          expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual(['a.md']);
          expect(result.warnings).toContainEqual(
            expect.objectContaining({ code: 'special-file', path: 'channel.sock' }),
          );
        } finally {
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve(undefined))),
          );
        }
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a followed socket link instead of indexing its supported suffix',
    async () => {
      await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async ({ root }) => {
        const server = createServer();
        server.listen(join(root, 'channel.sock'));
        await once(server, 'listening');
        try {
          symlinkSync(join(root, 'channel.sock'), join(root, 'linked.md'));
          const config = loadConfig({ cwd: root });
          const result = discover({
            config: { ...config, effective: { ...config.effective, followSymlinks: true } },
          });
          expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual(['a.md']);
          expect(result.warnings).toContainEqual(
            expect.objectContaining({ code: 'special-file', path: 'linked.md' }),
          );
        } finally {
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve(undefined))),
          );
        }
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports an ignored special entry under its deciding rule',
    async () => {
      await withTempProject(
        { files: { 'lore.yaml': CONFIG, '.loreignore': 'channel.sock\n', 'a.md': '# A' } },
        async ({ root }) => {
          const socket = createServer();
          socket.listen(join(root, 'channel.sock'));
          await once(socket, 'listening');
          try {
            const result = discover({ config: loadConfig({ cwd: root }) });
            expect(result.warnings).toEqual([]);
            expect(result.exclusions).toContainEqual(
              expect.objectContaining({
                pattern: 'channel.sock',
                count: 1,
                sample: ['channel.sock'],
              }),
            );
          } finally {
            await new Promise<void>((resolve, reject) =>
              socket.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
    },
  );

  // Linux and Windows retain both byte spellings; normalization-insensitive APFS cannot.
  it.skipIf(process.platform === 'darwin')(
    'rejects two real names with the same canonical identity before indexing',
    async () => {
      await withTempProject({ files: { 'lore.yaml': CONFIG } }, ({ root }) => {
        writeFileSync(join(root, `${composed}.md`), '# One');
        writeFileSync(join(root, `${decomposed}.md`), '# Two');
        expect(readdirSync(root)).toEqual(
          expect.arrayContaining([`${composed}.md`, `${decomposed}.md`]),
        );
        expect(() => discover({ config: loadConfig({ cwd: root }) })).toThrowError(
          expect.objectContaining({ code: 'LORE_E_CASE_COLLISION' }),
        );
      });
    },
  );
});
