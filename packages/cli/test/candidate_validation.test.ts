import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createLocalRuntimeBackend,
  LocalStateStore,
  ProjectLock,
  sealCandidateDirectory,
  stateMigrationsDirectory,
} from '@lorepack/backend-local';
import {
  type BuildId,
  buildManifestSchema,
  hashBytes,
  LoreError,
  loadConfig,
  loadProjectConfig,
  ProgressBus,
  renderAsJson,
  renderForCli,
} from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readActiveBuild } from '../src/services/project.js';
import { startServing } from '../src/services/serving.js';
import { run } from './helpers.js';

const corruption = vi.hoisted(() => ({
  kind: 'none' as 'none' | 'table' | 'locator' | 'index' | 'checksum',
  objectRoot: '',
  checksumHash: '',
}));
vi.mock('@lorepack/backend-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorepack/backend-local')>();
  return {
    ...actual,
    writeCatalog: (options: Parameters<typeof actual.writeCatalog>[0]) => {
      if (corruption.kind === 'index') {
        const { page_count } = options.db.prepare('PRAGMA page_count').get() as {
          page_count: number;
        };
        options.db.exec(`PRAGMA max_page_count = ${page_count}`);
      }
      const counts = actual.writeCatalog(options);
      if (corruption.kind === 'table') options.db.exec('UPDATE tables SET row_count=99');
      if (corruption.kind === 'locator')
        options.db.exec("UPDATE nodes SET line_end=100000 WHERE kind='paragraph'");
      if (corruption.kind === 'checksum') {
        const policy = options.artifacts.find(
          (entry) => entry.artifact.relativePath === 'policy.md',
        );
        if (policy === undefined) throw new Error('The changed policy must reach indexing.');
        const hash = policy.objectHash;
        corruption.checksumHash = hash;
        writeFileSync(
          join(corruption.objectRoot, 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4)),
          'corrupt normalized body',
        );
      }
      return counts;
    },
  };
});

async function history(root: string) {
  const config = loadConfig({ cwd: root });
  const first = await runBuild({ config, progress: new ProgressBus() });
  writeFileSync(join(root, 'docs/policy.md'), '# Policy\n\nRecovery checkpoint B.\n');
  const second = await runBuild({ config, progress: new ProgressBus() });
  expect(second.buildId).not.toBe(first.buildId);
  return { config, first, second };
}

function recorded(root: string) {
  const state = LocalStateStore.open(join(root, '.lore'), stateMigrationsDirectory());
  try {
    return { active: state.current(), builds: state.listBuilds() };
  } finally {
    state.close();
  }
}

async function sourceFreeRecovery(root: string, first: BuildId, second: BuildId) {
  rmSync(join(root, 'docs'), { recursive: true });
  rmSync(join(root, '.lore/cache'), { recursive: true, force: true });
  const readable = async (buildId: BuildId, text: string) => {
    const backend = createLocalRuntimeBackend({ projectRoot: root });
    try {
      const result = await createRuntime(backend).readSource({ path: 'policy.md' });
      expect(result.buildId).toBe(buildId);
      expect(result.text).toContain(text);
    } finally {
      backend.close();
    }
    const server = await startServing({
      config: loadProjectConfig({ cwd: root }),
      host: '127.0.0.1',
      port: 49_420,
      warn: () => {},
    });
    try {
      const response = await fetch(`${server.url}/v1/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ query: 'Policy' }),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ buildId });
      expect(JSON.stringify(result)).toContain(text);
    } finally {
      await server.close();
    }
  };
  await readable(second, 'Recovery checkpoint B.');
  const rolledBack = await run(['--cwd', root, '--json', 'rollback']);
  expect(rolledBack.code).toBe(0);
  expect(JSON.parse(rolledBack.stdout)).toMatchObject({ buildId: first });
  await readable(first, 'Original A.');
  const lock = new ProjectLock(join(root, '.lore/lock'), { waitMs: 0 });
  await lock.withLock(async () => undefined);
  expect(readdirSync(join(root, '.lore/tmp'))).toEqual([]);
}

it.each(['table', 'locator'] as const)(
  'rejects a stored candidate %s corruption before sealing or activation, issue415',
  async (kind) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: candidate\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nOriginal A.\n',
          'docs/data.csv': 'id,value\n00017,120000\n',
        },
      },
      async (project) => {
        const { config, first, second } = await history(project.root);
        const lore = join(project.root, '.lore');
        const active = readActiveBuild(lore);
        const builds = readdirSync(join(lore, 'builds'));
        writeFileSync(join(project.root, 'docs/policy.md'), '# Policy\n\nChanged B.\n');
        corruption.kind = kind;
        try {
          await expect(runBuild({ config, progress: new ProgressBus() })).rejects.toMatchObject({
            code: 'LORE_E_BUILD_VALIDATION',
            details: {
              failures: expect.arrayContaining([
                {
                  check: kind === 'table' ? 'table-mapping' : 'locator-ranges',
                  message: expect.any(String),
                  subject: expect.any(String),
                },
              ]),
            },
          });
          expect(readActiveBuild(lore)).toEqual(active);
          expect(readdirSync(join(lore, 'builds'))).toEqual(builds);
        } finally {
          corruption.kind = 'none';
        }
        await sourceFreeRecovery(project.root, first.buildId, second.buildId);
      },
    );
  },
);

it.each(['parse', 'index', 'checksum', 'seal', 'state-record'] as const)(
  'keeps prior builds readable and rollback available after %s failure, CORE08',
  async (fault) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: candidate\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nOriginal A.\n',
        },
      },
      async (project) => {
        const { config, first, second } = await history(project.root);
        const before = recorded(project.root);
        const lore = join(project.root, '.lore');
        const directories = readdirSync(join(lore, 'builds'));
        writeFileSync(
          project.path('docs/policy.md'),
          `# Policy\n\nChanged candidate C. ${'Uncommitted policy content. '.repeat(4_000)}\n`,
        );
        if (fault === 'parse') writeFileSync(project.path('docs/broken.docx'), 'not a ZIP archive');
        if (fault === 'state-record') {
          const state = new DatabaseSync(join(lore, 'state.sqlite'));
          try {
            state.exec(
              "CREATE TRIGGER core08_refuse_record BEFORE INSERT ON builds BEGIN SELECT RAISE(ABORT, 'CORE08 insert refused'); END",
            );
          } finally {
            state.close();
          }
        }
        const started: string[] = [];
        const finished: string[] = [];
        const progress = new ProgressBus();
        progress.subscribe((event) => {
          if (event.type === 'stage-started') started.push(event.stage);
          if (event.type === 'stage-finished') finished.push(event.stage);
        });
        corruption.kind = fault === 'index' || fault === 'checksum' ? fault : 'none';
        corruption.objectRoot = join(lore, 'objects');
        let failure: unknown;
        try {
          await runBuild({
            config,
            progress,
            ...(fault === 'seal'
              ? {
                  seal: (candidate, destination) =>
                    sealCandidateDirectory(candidate, destination, {
                      rename: () => {
                        throw Object.assign(new Error('CORE08 seal denied'), { code: 'EACCES' });
                      },
                    }),
                }
              : {}),
          });
        } catch (error) {
          failure = error;
        } finally {
          corruption.kind = 'none';
          if (fault === 'state-record') {
            const state = new DatabaseSync(join(lore, 'state.sqlite'));
            try {
              state.exec('DROP TRIGGER core08_refuse_record');
            } finally {
              state.close();
            }
          }
        }
        expect(failure).toBeInstanceOf(Error);
        const expectedStage = {
          parse: 'parsing',
          index: 'indexing',
          checksum: 'validating',
          seal: 'sealing',
          'state-record': 'sealing',
        }[fault];
        expect(started.at(-1)).toBe(expectedStage);
        const diagnostic = renderAsJson(failure, { secrets: [] }).error;
        if (fault === 'parse')
          expect(failure).toMatchObject({
            code: 'LORE_E_UNSUPPORTED_FORMAT',
            path: 'docs/broken.docx',
            message: 'docs/broken.docx is not a readable .docx archive.',
            remediation: expect.stringContaining('exclude it in .loreignore'),
          });
        if (fault === 'index') {
          expect(failure).toMatchObject({
            code: 'LORE_E_DISK_FULL',
            remediation: expect.stringMatching(/free/i),
            cause: expect.objectContaining({
              code: 'LORE_E_DISK_FULL',
              cause: expect.objectContaining({ errcode: 13 }),
            }),
          });
          expect(diagnostic).toMatchObject({
            code: 'LORE_E_DISK_FULL',
            message: expect.stringMatching(/indexing/i),
            path: expect.stringMatching(/^\.lore\/tmp\/[^/]+\/context\.sqlite$/),
            subject: expect.stringMatching(/^lore_[a-f0-9]{64}$/),
            details: { stage: 'indexing' },
          });
          expect(diagnostic.causes?.join(' ')).toMatch(/full/i);
          const human = renderForCli(failure, { color: false, secrets: [] });
          expect(human).toContain('indexing');
          expect(human).toContain(diagnostic.path);
        }
        if (fault === 'checksum') {
          expect(failure).toMatchObject({
            code: 'LORE_E_OBJECT_CORRUPT',
            subject: corruption.checksumHash,
            remediation: expect.stringContaining('roll back and rebuild'),
            details: {
              expected: corruption.checksumHash,
              actual: hashBytes(new TextEncoder().encode('corrupt normalized body')),
            },
          });
          expect(diagnostic).toMatchObject({
            code: 'LORE_E_OBJECT_CORRUPT',
            message: expect.stringMatching(/validating/i),
            subject: corruption.checksumHash,
            details: {
              stage: 'validating',
              expected: corruption.checksumHash,
              actual: hashBytes(new TextEncoder().encode('corrupt normalized body')),
            },
          });
          expect(diagnostic.causes?.join(' ')).toContain('failed its checksum');
          expect(failure).toMatchObject({
            cause: expect.objectContaining({
              code: 'LORE_E_OBJECT_CORRUPT',
              subject: corruption.checksumHash,
              details: { expected: corruption.checksumHash, actual: diagnostic.details?.actual },
            }),
          });
          const human = renderForCli(failure, { color: false, secrets: [] });
          expect(human).toContain('validating');
          expect(human).toContain(corruption.checksumHash);
        }
        if (fault === 'seal') {
          expect(failure).toMatchObject({
            code: 'LORE_E_INTERNAL',
            cause: expect.objectContaining({ code: 'EACCES' }),
          });
          expect(diagnostic).toMatchObject({
            message: expect.stringMatching(
              /Could not seal a build into .*[/\\]\.lore[/\\]builds[/\\]lore_[a-f0-9]{64}\./,
            ),
            remediation: 'Check free space and that no other process holds the directory.',
            causes: expect.arrayContaining(['CORE08 seal denied']),
          });
        }
        expect(recorded(project.root)).toEqual(before);
        expect(readActiveBuild(lore)).toEqual(before.active);
        if (fault === 'state-record') {
          expect(failure).toMatchObject({
            code: 'LORE_E_INTERNAL',
            message: expect.stringContaining('recording build'),
            path: '.lore/state.sqlite',
            details: { stage: 'state-record' },
            remediation: expect.stringContaining('lorepack build'),
            cause: expect.objectContaining({ message: 'CORE08 insert refused' }),
          });
          const diagnostic = JSON.stringify(renderAsJson(failure, { secrets: [] }));
          expect(diagnostic).toMatch(/state-record|recordBuild|recording a? ?build/i);
          expect(finished).toContain('sealing');
          const unrecorded = readdirSync(join(lore, 'builds')).filter(
            (id) => !directories.includes(id),
          );
          expect(unrecorded).toHaveLength(1);
          const manifest = buildManifestSchema.parse(
            JSON.parse(
              readFileSync(join(lore, 'builds', unrecorded[0] as string, 'manifest.json'), 'utf8'),
            ),
          );
          expect(manifest.buildId).not.toBe(second.buildId);
          expect(failure).toMatchObject({ subject: manifest.buildId });
          expect(before.builds.some((build) => build.buildId === manifest.buildId)).toBe(false);
          const refused = await run([
            '--cwd',
            project.root,
            '--json',
            'activate',
            manifest.buildId,
          ]);
          expect(refused.code).not.toBe(0);
          expect(JSON.parse(refused.stdout)).toMatchObject({
            error: { code: 'LORE_E_BUILD_NOT_FOUND' },
          });
          expect(recorded(project.root)).toEqual(before);
          const sealedRoot = join(lore, 'builds', manifest.buildId);
          const sealedBytes = new Map(
            ['manifest.json', 'context.sqlite'].map((name) => [
              name,
              readFileSync(join(sealedRoot, name)),
            ]),
          );
          const retried = await runBuild({
            config,
            progress: new ProgressBus(),
            activate: false,
          });
          expect(retried.buildId).toBe(manifest.buildId);
          expect(retried.activated).toBe(false);
          const recovered = recorded(project.root);
          expect(recovered.active).toEqual(before.active);
          expect(recovered.builds).toEqual(
            expect.arrayContaining([
              ...before.builds,
              expect.objectContaining({ buildId: manifest.buildId, state: 'verified' }),
            ]),
          );
          expect(recovered.builds).toHaveLength(before.builds.length + 1);
          for (const [name, bytes] of sealedBytes)
            expect(readFileSync(join(sealedRoot, name))).toEqual(bytes);
        } else expect(readdirSync(join(lore, 'builds'))).toEqual(directories);
        await sourceFreeRecovery(project.root, first.buildId, second.buildId);
      },
    );
  },
);

it.each(['disk-full', 'typed'] as const)(
  'preserves %s classification and cause at the state-record boundary',
  async (kind) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: candidate\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nOriginal A.\n',
        },
      },
      async (project) => {
        const { config, first, second } = await history(project.root);
        const before = recorded(project.root);
        writeFileSync(project.path('docs/policy.md'), '# Policy\n\nUnrecorded C.\n');
        const cause =
          kind === 'disk-full'
            ? Object.assign(new Error('CORE08 state disk full'), { code: 'ENOSPC' })
            : new LoreError('LORE_E_BUSY', 'CORE08 typed state error', {
                remediation: 'Release the state writer and retry.',
                details: { owner: 'state writer' },
              });
        const record = vi
          .spyOn(LocalStateStore.prototype, 'recordBuild')
          .mockImplementationOnce(() => {
            throw cause;
          });
        let failure: unknown;
        try {
          await runBuild({ config, progress: new ProgressBus(), now: () => new Date(0) });
        } catch (error) {
          failure = error;
        } finally {
          record.mockRestore();
        }
        expect(failure).toMatchObject({
          code: kind === 'disk-full' ? 'LORE_E_DISK_FULL' : 'LORE_E_BUSY',
          path: '.lore/state.sqlite',
          details: {
            stage: 'state-record',
            ...(kind === 'typed' ? { owner: 'state writer' } : {}),
          },
          remediation:
            kind === 'disk-full'
              ? expect.stringMatching(/free disk space/i)
              : 'Release the state writer and retry.',
        });
        expect((failure as Error).cause).toBe(cause);
        expect(recorded(project.root)).toEqual(before);
        await sourceFreeRecovery(project.root, first.buildId, second.buildId);
      },
    );
  },
);
