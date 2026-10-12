import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureCampaign, nodeCommand } from '../../../scripts/coverage_capture.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lorepack-capture-driver-')));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function inventory() {
  const path = 'packages/core/vitest.config.ts';
  const code = "export default {test:{include:['test/*.test.ts']}};";
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, 'packages/core/package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(directory, path), code);
  const snapshot = join(directory, 'inventory.json');
  writeFileSync(
    snapshot,
    JSON.stringify({
      root: directory,
      included: [{ path, sha256: createHash('sha256').update(code).digest('hex') }],
    }),
  );
  return { path, snapshot };
}

describe('coverage campaign execution boundaries', () => {
  it('propagates the actual failed child exit', () => {
    try {
      nodeCommand(ROOT, ['-e', 'process.exit(7)']);
      throw new Error('Expected the child command to fail.');
    } catch (error) {
      expect(error).toMatchObject({ status: 7 });
    }
  });

  it('passes explicit capture environment to the actual child', () => {
    const marker = join(directory, 'environment.txt');
    nodeCommand(
      ROOT,
      [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1],process.env.LOREPACK_CAPTURE_WITNESS)",
        marker,
      ],
      { LOREPACK_CAPTURE_WITNESS: 'capture-only' },
    );
    expect(readFileSync(marker, 'utf8')).toBe('capture-only');
    expect(process.env.LOREPACK_CAPTURE_WITNESS).toBeUndefined();
  });

  it('requires the actual pnpm script entrypoint', async () => {
    await expect(captureCampaign(ROOT, join(directory, 'output'), undefined)).rejects.toThrow(
      'pnpm coverage:capture',
    );
    expect(existsSync(join(directory, 'output'))).toBe(false);
  });

  it('refuses existing output rather than overwriting evidence', async () => {
    const output = join(directory, 'existing');
    mkdirSync(output);
    const retained = join(output, 'retained.json');
    writeFileSync(retained, '{"original":true}\n');
    await expect(captureCampaign(ROOT, output, 'unused')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(retained, 'utf8')).toBe('{"original":true}\n');
  });

  it('stops a campaign when its actual build child fails', async () => {
    const failedBuild = join(directory, 'failed-build.mjs');
    writeFileSync(failedBuild, 'process.exit(7);');
    const output = join(directory, 'build-failure');
    await expect(captureCampaign(ROOT, output, failedBuild)).rejects.toMatchObject({ status: 7 });
    expect(existsSync(join(output, 'inventory.json'))).toBe(false);
    expect(existsSync(join(output, 'report.json'))).toBe(false);
  });

  it('imports config through the actual CLI and captures genuine Node execution', () => {
    const { path, snapshot } = inventory();
    const results = join(directory, 'results.json');
    const raw = join(directory, 'raw-v8');
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/coverage_capture.mjs'),
        '--import-configs',
        snapshot,
        '--results',
        results,
      ],
      {
        env: { ...process.env, NODE_V8_COVERAGE: raw },
        stdio: 'pipe',
      },
    );
    expect(JSON.parse(readFileSync(results, 'utf8'))).toEqual([
      { path, imported: true, configurationAssertions: 'passed' },
    ]);
    const records = readdirSync(raw)
      .filter((file) => file.startsWith('coverage-'))
      .flatMap((file) => JSON.parse(readFileSync(join(raw, file), 'utf8')).result);
    const script = records.find((entry: { url: string }) =>
      entry.url.endsWith('/packages/core/vitest.config.ts'),
    );
    expect(script).toBeDefined();
    expect(script.functions[0].ranges[0].count).toBeGreaterThan(0);
  });

  it('rejects a stale config in the real CLI without writing import results', () => {
    const { path, snapshot } = inventory();
    writeFileSync(join(directory, path), "throw new Error('Stale config executed.');");
    const results = join(directory, 'stale.results.json');
    expect(() =>
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'scripts/coverage_capture.mjs'),
          '--import-configs',
          snapshot,
          '--results',
          results,
        ],
        { stdio: 'pipe' },
      ),
    ).toThrow('Stale configuration source');
    expect(existsSync(results)).toBe(false);
  });
});
