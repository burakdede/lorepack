import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { buildManifestSchema, loadConfig, ProgressBus } from '@lorepack/core';
import {
  cmapBombPdf,
  nestedBracketsMarkdown,
  singleCharacterCsv,
  withTempProject,
} from '@lorepack/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLimitsFromEnvironment, runBuild } from '../src/services/build.js';
import { ENVIRONMENT_KEYS } from '../src/services/config-resolve.js';
import { readActiveBuild } from '../src/services/project.js';

/**
 * Issue 594: a file that hangs or exhausts its parser is left out with a warning, and the
 * build still ends, activates, and says which file it was.
 *
 * The limits are set low so the fixtures exceed them in a second. What is under test is the
 * build's handling of an exceeded limit; the limits themselves are covered in the parsers
 * package.
 */

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';
const README = '# Notes\n\nRollback restores the previous release.\n';
const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

function manifestOf(root: string, buildId: string) {
  return buildManifestSchema.parse(
    JSON.parse(readFileSync(join(root, '.lore', 'builds', buildId, 'manifest.json'), 'utf8')),
  );
}

describe('a file that exceeds a parse limit', () => {
  it('is left out with a typed warning, and the build activates without it', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'readme.md': README } }, async (temp) => {
      writeFileSync(join(temp.root, 'brackets.md'), nestedBracketsMarkdown(100_000));
      writeFileSync(join(temp.root, 'rows.csv'), singleCharacterCsv(4_000_000));
      writeFileSync(join(temp.root, 'cmap.pdf'), cmapBombPdf(1));

      const started = Date.now();
      const result = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
        // Long enough for the memory fixtures to reach the ceiling first on a slow runner;
        // the bracket file needs minutes, so it still meets the deadline.
        parseLimits: { timeoutMs: 5_000, memoryMb: 128 },
      });

      expect(Date.now() - started).toBeLessThan(60_000);
      expect(result.activated).toBe(true);
      expect(result.counts.artifacts).toBe(1);
      expect(readActiveBuild(join(temp.root, '.lore'))?.buildId).toBe(result.buildId);

      const warnings = manifestOf(temp.root, result.buildId).warnings;
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'parse-timeout',
            path: 'brackets.md',
            class: 'envelope',
          }),
          expect.objectContaining({ code: 'parse-memory', path: 'rows.csv', class: 'envelope' }),
          expect.objectContaining({ code: 'parse-memory', path: 'cmap.pdf', class: 'envelope' }),
        ]),
      );
    });
  });

  it('does not make the limits part of the build id', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'readme.md': README } }, async (temp) => {
      const config = loadConfig({ cwd: temp.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      const second = await runBuild({
        config,
        progress: new ProgressBus(),
        parseLimits: { timeoutMs: 20_000, memoryMb: 512 },
      });
      expect(second.buildId).toBe(first.buildId);
    });
  });
});

describe('parse limits from the environment', () => {
  it('lists both variables among the environment keys, so `lorepack config` shows them', () => {
    expect(ENVIRONMENT_KEYS).toEqual(
      expect.arrayContaining(['LORE_PARSE_TIMEOUT_MS', 'LORE_PARSE_MEMORY_MB']),
    );
  });

  it('defaults to 30 seconds and 2048 MB', () => {
    expect(parseLimitsFromEnvironment({})).toEqual({ timeoutMs: 30_000, memoryMb: 2_048 });
  });

  it('reads both variables', () => {
    expect(
      parseLimitsFromEnvironment({ LORE_PARSE_TIMEOUT_MS: '5000', LORE_PARSE_MEMORY_MB: '512' }),
    ).toEqual({ timeoutMs: 5_000, memoryMb: 512 });
  });

  for (const [name, value] of [
    ['LORE_PARSE_TIMEOUT_MS', ''],
    ['LORE_PARSE_TIMEOUT_MS', 'soon'],
    ['LORE_PARSE_TIMEOUT_MS', '1.5'],
    ['LORE_PARSE_TIMEOUT_MS', '50'],
    ['LORE_PARSE_TIMEOUT_MS', '3600001'],
    ['LORE_PARSE_MEMORY_MB', '0'],
    ['LORE_PARSE_MEMORY_MB', '32769'],
    ['LORE_PARSE_MEMORY_MB', '-1'],
  ] as const) {
    it(`refuses ${name}=${JSON.stringify(value)} as a typed argument error`, () => {
      expect(() => parseLimitsFromEnvironment({ [name]: value })).toThrow(
        expect.objectContaining({ code: 'LORE_E_INVALID_ARGUMENT' }),
      );
    });
  }
});

describe('the published binary', () => {
  /**
   * Through `public-entry.js`, the bundle users run, not `entry.js`. Bundling moves the host's
   * `import.meta.url` to the bundle, so the child has to be emitted beside it; a build through
   * `entry.js` would pass with the child missing from the package (the trap #639 found for
   * the query child).
   */
  it('parses in its own child and leaves out a file over the deadline', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'readme.md': README } }, async (temp) => {
      writeFileSync(join(temp.root, 'brackets.md'), nestedBracketsMarkdown(100_000));
      const run = (args: readonly string[]) =>
        JSON.parse(
          execFileSync(process.execPath, [BINARY, '--cwd', temp.root, '--json', ...args], {
            encoding: 'utf8',
            env: { ...process.env, LORE_PARSE_TIMEOUT_MS: '2000' },
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        ) as Record<string, unknown>;

      const built = run(['build']);
      expect(built).toMatchObject({ activated: true, counts: { artifacts: 1 } });
      const manifest = manifestOf(temp.root, built.buildId as string);
      expect(manifest.warnings).toEqual([
        expect.objectContaining({ code: 'parse-timeout', path: 'brackets.md' }),
      ]);
    });
  });
});

/** POSIX only: Windows has no way to deliver SIGINT to one process from another. */
const CAN_SIGNAL_GRACEFULLY = platform() !== 'win32';

const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

describe.runIf(CAN_SIGNAL_GRACEFULLY)('Ctrl-C during a long parse', () => {
  it('cancels within a second, ends the parse process, and keeps the active build', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'readme.md': README } }, async (temp) => {
      const run = (args: readonly string[]) =>
        JSON.parse(
          execFileSync(process.execPath, [BINARY, '--cwd', temp.root, '--json', ...args], {
            encoding: 'utf8',
          }),
        ) as Record<string, unknown>;
      const before = run(['build']).buildId as string;

      writeFileSync(join(temp.root, 'brackets.md'), nestedBracketsMarkdown(100_000));
      const child = spawn(process.execPath, [BINARY, '--cwd', temp.root, '--json', 'build'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LORE_PARSE_TIMEOUT_MS: '120000' },
      });
      running.push(child);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      // The parse process exists once the slow file has been handed to it.
      const parseChildren = (): number[] =>
        execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter(
            ([, ppid, ...command]) =>
              Number(ppid) === child.pid && command.join(' ').includes('parse-child.js'),
          )
          .map(([pid]) => Number(pid));
      const deadline = Date.now() + 60_000;
      let parsing: number[] = [];
      while (parsing.length === 0 && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (stderr.includes('Parsing')) parsing = parseChildren();
      }
      expect(parsing, `no parse process appeared. stderr:\n${stderr}`).not.toHaveLength(0);
      // Inside the slow parse, not between files where a checkpoint would catch it anyway.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const signalled = Date.now();
      child.kill('SIGINT');
      const code = await new Promise<number>((resolve) => {
        child.once('exit', (value) => resolve(value ?? 0));
      });
      const elapsed = Date.now() - signalled;

      expect(elapsed, `took ${elapsed} ms to stop`).toBeLessThan(1_000);
      expect(code).not.toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ error: { code: 'LORE_E_CANCELLED' } });
      // Killed by the build before it exited; the short wait is only for the orphaned
      // zombie to be reaped, which is what makes `kill(pid, 0)` start failing.
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const reaped = Date.now() + 2_000;
      while (parsing.some(alive) && Date.now() < reaped) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(parsing.filter(alive), 'a parse process outlived the build').toEqual([]);
      expect(run(['status']).activeBuildId).toBe(before);
    });
  }, 120_000);
});
