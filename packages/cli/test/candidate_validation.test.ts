import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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

it.each(['parsing', 'indexing', 'validating', 'sealing', 'state-record'] as const)(
  'recovers after a real process interruption at the %s boundary, CORE08',
  async (boundary) => {
    const dist = join(import.meta.dirname, '..', 'dist');
    const binary = realpathSync(join(dist, 'public-entry.js'));
    const progressSource = readFileSync(
      join(import.meta.dirname, '..', '..', 'core', 'src', 'progress', 'events.ts'),
      'utf8',
    );
    const modules = readdirSync(dist)
      .filter((name) => name.endsWith('.js.map'))
      .filter((name) => {
        const map = JSON.parse(readFileSync(join(dist, name), 'utf8')) as {
          sources: string[];
          sourcesContent: string[];
        };
        const index = map.sources.findIndex((source) =>
          source.endsWith('/core/src/progress/events.ts'),
        );
        if (index === -1) return false;
        expect(map.sourcesContent[index]).toBe(progressSource);
        return true;
      })
      .map((name) => realpathSync(join(dist, name.slice(0, -4))));
    expect(modules).toHaveLength(1);
    const progressModule = modules[0] as string;
    expect(readFileSync(progressModule, 'utf8')).toMatch(/export\s*\{[^}]*\bProgressBus\b/s);
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: interrupted-candidate\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nOriginal A.\n',
        },
      },
      async (project) => {
        const { first, second } = await history(project.root);
        const before = recorded(project.root);
        const lore = join(project.root, '.lore');
        const directories = readdirSync(join(lore, 'builds'));
        writeFileSync(project.path('docs/policy.md'), '# Policy\n\nInterrupted candidate C.\n');
        const marker = project.path('boundary.json');
        const preload = project.path('boundary-preload.mjs');
        const eventType = boundary === 'state-record' ? 'stage-finished' : 'stage-started';
        const stage = boundary === 'state-record' ? 'sealing' : boundary;
        writeFileSync(
          preload,
          `import { realpathSync, writeFileSync } from 'node:fs';
if (process.ppid === ${process.pid} && process.argv[1] && realpathSync(process.argv[1]) === ${JSON.stringify(binary)}) {
  const { ProgressBus } = await import(${JSON.stringify(pathToFileURL(progressModule).href)});
  if (typeof ProgressBus !== 'function') throw new Error('The actual ProgressBus export is required.');
  const emit = ProgressBus.prototype.emit;
  ProgressBus.prototype.emit = function(event) {
    emit.call(this, event);
    if (event.type === ${JSON.stringify(eventType)} && event.stage === ${JSON.stringify(stage)}) {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, entry: realpathSync(process.argv[1]), event }));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  };
}
`,
        );
        const argv = [
          '--import',
          pathToFileURL(preload).href,
          binary,
          '--cwd',
          project.root,
          '--json',
          'build',
        ];
        const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let launchError: Error | undefined;
        let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', (error) => {
          launchError = error;
        });
        const closed = new Promise<void>((resolve) => {
          child.once('close', (code, signal) => {
            terminal = { code, signal };
            resolve();
          });
        });
        const waitForClose = async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('The interrupted build did not close.')),
                  10_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          const deadline = Date.now() + 30_000;
          while (!existsSync(marker)) {
            if (launchError !== undefined) throw launchError;
            if (terminal !== undefined)
              throw new Error(
                `Build exited before ${boundary}: ${JSON.stringify({ terminal, stdout, stderr })}`,
              );
            if (Date.now() >= deadline)
              throw new Error(`Build did not reach ${boundary}: ${stderr}`);
            await delay(20);
          }
          const observed = JSON.parse(readFileSync(marker, 'utf8'));
          expect(observed).toMatchObject({
            pid: child.pid,
            ppid: process.pid,
            entry: binary,
            event: { type: eventType, stage },
          });
          expect(terminal).toBeUndefined();
          const staging = readdirSync(join(lore, 'tmp'));
          const added = readdirSync(join(lore, 'builds')).filter((id) => !directories.includes(id));
          if (boundary === 'state-record') {
            expect(staging).toEqual([]);
            expect(added).toHaveLength(1);
            const manifest = buildManifestSchema.parse(
              JSON.parse(
                readFileSync(join(lore, 'builds', added[0] as string, 'manifest.json'), 'utf8'),
              ),
            );
            expect(manifest.buildId).toBe(added[0]);
            expect(existsSync(join(lore, 'builds', manifest.buildId, 'context.sqlite'))).toBe(true);
          } else {
            expect(added).toEqual([]);
            expect(staging).toHaveLength(boundary === 'parsing' ? 0 : 1);
            if (boundary !== 'parsing') {
              const candidate = join(lore, 'tmp', staging[0] as string);
              expect(staging[0]).toMatch(/^candidate-/);
              expect(existsSync(join(candidate, 'context.sqlite'))).toBe(boundary !== 'indexing');
              expect(existsSync(join(candidate, 'manifest.json'))).toBe(boundary === 'sealing');
            }
          }
          expect(existsSync(join(lore, 'lock'))).toBe(true);
          expect(child.kill('SIGKILL')).toBe(true);
          await waitForClose();
          expect(terminal).toBeDefined();
          expect(recorded(project.root)).toEqual(before);
          expect(readActiveBuild(lore)).toEqual(before.active);
          expect(stdout.trim()).toBe('');
          const restarted = await promisify(execFile)(
            process.execPath,
            [binary, '--cwd', project.root, '--json', 'build', '--no-activate'],
            { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
          );
          const restart = JSON.parse(restarted.stdout);
          expect(restart).toMatchObject({
            activated: false,
            buildId: expect.stringMatching(/^lore_[a-f0-9]{64}$/),
          });
          if (boundary === 'state-record') expect(restart.buildId).toBe(added[0]);
          expect(recorded(project.root).active).toEqual(before.active);
          expect(recorded(project.root).builds).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ buildId: restart.buildId, state: 'verified' }),
            ]),
          );
          expect(readdirSync(join(lore, 'tmp'))).toEqual([]);
          expect(existsSync(join(lore, 'lock'))).toBe(false);
          console.info(
            'CORE08 boundary interruption receipt',
            JSON.stringify({
              boundary,
              argv,
              observed,
              terminal,
              staging,
              added,
              stdout,
              stderr,
              restart,
              restartStderr: restarted.stderr,
            }),
          );
          await sourceFreeRecovery(project.root, first.buildId, second.buildId);
        } finally {
          if (terminal === undefined) child.kill('SIGKILL');
          await waitForClose();
        }
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
