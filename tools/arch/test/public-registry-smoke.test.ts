import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  globalSmokeEnvironment,
  parseGlobalSmokeArgs,
} from '../../../scripts/check-global-smoke.mjs';
import {
  assertCommandSucceeded,
  assertExportResult,
  assertSearchResult,
  parseReleaseVersion,
  readInstalledCli,
  runSmokeCommand,
} from '../../../scripts/public-registry-smoke.mjs';

describe('public registry smoke assertions', () => {
  it('accepts stable and prerelease versions and rejects shell-shaped input', () => {
    expect(parseReleaseVersion('v0.1.0')).toBe('0.1.0');
    expect(parseReleaseVersion('0.1.0-rc.1')).toBe('0.1.0-rc.1');
    expect(() => parseReleaseVersion('0.1.0; touch compromised')).toThrow(
      'invalid release version',
    );
  });

  it('turns command failures into failed smoke results', () => {
    expect(() =>
      assertCommandSucceeded({ status: 0, stdout: 'ok', stderr: '' }, ['lorepack', 'build']),
    ).not.toThrow();
    expect(() =>
      assertCommandSucceeded({ status: 1, stdout: '', stderr: 'broken' }, ['lorepack', 'build']),
    ).toThrow('lorepack build exited 1');
  });

  it('requires complete provenance on every search hit', () => {
    expect(() =>
      assertSearchResult({ hits: [{ locator: { artifactId: 'a', relativePath: 'runbook.md' } }] }),
    ).not.toThrow();
    expect(() =>
      assertSearchResult({ hits: [{ locator: { relativePath: 'runbook.md' } }] }),
    ).toThrow('without complete provenance');
  });

  it('requires citations in exported context', () => {
    expect(() =>
      assertExportResult({ buildId: 'lore_a', citations: [{ relativePath: 'runbook.md' }] }),
    ).not.toThrow();
    expect(() => assertExportResult({ buildId: 'lore_a', citations: [] })).toThrow(
      'no cited context',
    );
  });
});

describe('disposable global smoke', () => {
  it('uses the real global install and preserves literal environment paths', () => {
    const prefix = 'global prefix & (literal) ^ %LOREPACK_LITERAL%';
    const temporary = 'project space & (literal) ^ %LOREPACK_LITERAL%';
    const original = {
      Path: 'original-path',
      NPM_CONFIG_PREFIX: 'user-global-prefix',
      LOREPACK_SMOKE_CLI: 'checkout-override.js',
      lorepack_smoke_cli: 'another-override.js',
      PRESERVED: 'unchanged',
    };
    const environment = globalSmokeEnvironment(prefix, temporary, original);
    expect(environment.PATH).toBe(
      `${process.platform === 'win32' ? prefix : join(prefix, 'bin')}${delimiter}original-path`,
    );
    expect(environment.npm_config_prefix).toBe(prefix);
    expect(environment.TMPDIR).toBe(temporary);
    expect(environment.TMP).toBe(temporary);
    expect(environment.TEMP).toBe(temporary);
    expect(environment.PRESERVED).toBe('unchanged');
    expect(
      Object.keys(environment).filter((key) => key.toLowerCase() === 'lorepack_smoke_cli'),
    ).toEqual([]);
    expect(
      Object.keys(environment).filter((key) => key.toLowerCase() === 'npm_config_prefix'),
    ).toEqual(['npm_config_prefix']);
    expect(original.NPM_CONFIG_PREFIX).toBe('user-global-prefix');
    expect(original.LOREPACK_SMOKE_CLI).toBe('checkout-override.js');
  });
});

describe('installed CLI entry', () => {
  it('reads the actual global package with literal paths and rejects escaping entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'lorepack-global-entry-'));
    try {
      const globalRoot = join(root, 'global prefix & (literal) ^ %LOREPACK_LITERAL%');
      const packageRoot = join(globalRoot, '@lorepack', 'cli');
      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      const entry = join(packageRoot, 'dist', 'public-entry.js');
      writeFileSync(entry, 'process.exitCode = 0;');
      const manifest = join(packageRoot, 'package.json');
      writeFileSync(
        manifest,
        JSON.stringify({
          version: '0.1.0',
          bin: { lorepack: './dist/public-entry.js' },
        }),
      );
      expect(readInstalledCli(globalRoot)).toEqual({ version: '0.1.0', entry });
      for (const binary of ['../outside.js', join(root, 'outside.js'), './missing.js']) {
        writeFileSync(manifest, JSON.stringify({ version: '0.1.0', bin: { lorepack: binary } }));
        expect(() => readInstalledCli(globalRoot)).toThrow('missing or outside its package');
      }
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'outside.js'), 'process.exitCode = 0;');
      symlinkSync(
        outside,
        join(packageRoot, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      writeFileSync(
        manifest,
        JSON.stringify({
          version: '0.1.0',
          bin: { lorepack: './linked/outside.js' },
        }),
      );
      expect(() => readInstalledCli(globalRoot)).toThrow('missing or outside its package');
      for (const binary of ['', null, 42]) {
        writeFileSync(manifest, JSON.stringify({ version: '0.1.0', bin: { lorepack: binary } }));
        expect(() => readInstalledCli(globalRoot)).toThrow('no lorepack entry');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('retained global lifecycle evidence', () => {
  it('retains the real failed child output before assertion and project removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'lorepack-smoke-record-'));
    const project = join(root, 'project');
    const evidence = join(root, 'command.json');
    mkdirSync(project);
    try {
      const result = runSmokeCommand(
        process.execPath,
        [
          '-e',
          "process.stdout.write('actual output'); process.stderr.write('actual failure'); process.exitCode = 7;",
        ],
        project,
        evidence,
      );
      expect(() => assertCommandSucceeded(result, ['fixture'])).toThrow('exited 7');
      rmSync(project, { recursive: true });
      expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({
        status: 7,
        stdout: 'actual output',
        stderr: 'actual failure',
        cwd: project,
        signal: null,
        error: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains the first actual smoke failure and cleanup receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'lorepack-smoke-failure-'));
    const entry = join(root, 'failed-entry.cjs');
    const out = join(root, 'evidence');
    try {
      writeFileSync(
        entry,
        "process.stdout.write('fixture stdout'); process.stderr.write('fixture stderr'); process.exitCode = 9;",
      );
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/public-registry-smoke.mjs'), '0.1.0', '--out', out],
        {
          env: { ...process.env, LOREPACK_SMOKE_CLI: entry },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      const receipt = JSON.parse(readFileSync(join(out, 'lifecycle.json'), 'utf8'));
      expect(receipt).toMatchObject({ passed: false, cleaned: true, commands: ['01-init.json'] });
      expect(receipt.error).toContain('exited 9');
      expect(JSON.parse(readFileSync(join(out, '01-init.json'), 'utf8'))).toMatchObject({
        status: 9,
        stdout: 'fixture stdout',
        stderr: 'fixture stderr',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records actual canonical builds, inactive validation and source-free rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'lorepack-smoke-lifecycle-'));
    try {
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/public-registry-smoke.mjs'), '0.1.0', '--out', root],
        {
          env: { ...process.env, LOREPACK_SMOKE_CLI: resolve('packages/cli/dist/public-entry.js') },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(result.stderr, result.stdout).not.toContain('public registry smoke failed');
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(join(root, 'lifecycle.json'), 'utf8'));
      expect(receipt).toMatchObject({ passed: true, cleaned: true, rolledBackTo: receipt.buildA });
      expect(receipt.buildA).not.toBe(receipt.buildB);
      expect(receipt.fixtures.A['lore.yaml']).toEqual(receipt.fixtures.B['lore.yaml']);
      expect(receipt.fixtures.A['docs/runbook.md'].sha256).not.toBe(
        receipt.fixtures.B['docs/runbook.md'].sha256,
      );
      const commands = receipt.commands.map((name: string) =>
        JSON.parse(readFileSync(join(root, name), 'utf8')),
      );
      expect(commands.every((command: { status: number }) => command.status === 0)).toBe(true);
      const candidate = commands.find((command: { args: string[] }) =>
        command.args.includes('--no-activate'),
      );
      expect(JSON.parse(candidate.stdout)).toMatchObject({
        buildId: receipt.buildB,
        activated: false,
      });
      const rollback = commands.find(
        (command: { args: string[] }) =>
          command.args.includes('rollback') && command.args.includes(receipt.buildA),
      );
      expect(JSON.parse(rollback.stdout).buildId).toBe(receipt.buildA);
      expect(commands.at(-3).args).toContain('builds');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts a preselected tar only outside evidence and rejects ambiguous flags', () => {
    const out = resolve('/tmp/smoke-evidence');
    const tarball = resolve('/tmp/retained.tgz');
    expect(parseGlobalSmokeArgs(['--out', out, '--tarball', tarball])).toEqual({
      outDir: out,
      tarball,
    });
    expect(parseGlobalSmokeArgs(['--out', out])).toEqual({ outDir: out, tarball: undefined });
    for (const args of [
      [],
      ['--out'],
      ['--other', out],
      ['--out', out, '--out', out],
      ['--out', out, '--tarball', join(out, 'retained.tgz')],
    ]) {
      expect(() => parseGlobalSmokeArgs(args)).toThrow();
    }
  });
});
