import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, ProgressBus, verifyContextReceipt } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const files = {
  'lore.yaml': 'version: 1\nname: export-receipt\nsources: [docs]\n',
  'docs/policy.md': '# Rollback\n\nRollback needs owner approval. Preserve café and 🧭.\n',
};

it.each(['json', 'markdown'])(
  'receipts exact source-free %s stdout including its final newline',
  async (format) => {
    await withTempProject({ files }, async (project) => {
      const built = await runBuild({
        config: loadConfig({ cwd: project.root }),
        progress: new ProgressBus(),
      });
      rmSync(join(project.root, 'docs'), { recursive: true });
      const path = join(project.root, 'receipt.json');
      const result = await execute(process.execPath, [
        BIN,
        '--cwd',
        project.root,
        'export',
        '--build',
        built.buildId,
        '--task',
        'rollback',
        '--format',
        format,
        '--receipt',
        path,
      ]);
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      expect(receipt.buildId).toBe(built.buildId);
      expect(receipt.payloadFormat).toBe(format);
      expect(receipt.payloadDigest).toBe(createHash('sha256').update(result.stdout).digest('hex'));
      expect(receipt.payloadBytes).toBe(Buffer.byteLength(result.stdout));
      expect(result.stdout.endsWith('\n')).toBe(true);
      expect(result.stdout).toContain('owner approval');
      expect(receipt.requestRetained).toBe(false);
      expect(await verifyContextReceipt(receipt, result.stdout)).toEqual(receipt);
    });
  },
);

it('receipts the output file independently of JSON acknowledgement stdout and captures only on request', async () => {
  await withTempProject({ files }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const output = join(project.root, 'context.md');
    const path = join(project.root, 'receipt.json');
    const result = await execute(process.execPath, [
      BIN,
      '--cwd',
      project.root,
      '--json',
      'export',
      '--task',
      'rollback',
      '--output',
      output,
      '--receipt',
      path,
      '--capture-request',
    ]);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    const payload = readFileSync(output, 'utf8');
    expect(receipt.payloadFormat).toBe('markdown');
    expect(receipt.request.task).toBe('rollback');
    expect(receipt.requestRetained).toBe(true);
    expect(receipt.payloadRetained).toBe(false);
    expect(await verifyContextReceipt(receipt, payload)).toEqual(receipt);
    expect(JSON.parse(result.stdout).buildId).toBe(receipt.buildId);
  });
});

it('refuses collisions and existing sidecars before replacing output bytes', async () => {
  await withTempProject({ files }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const output = join(project.root, 'context.json');
    const path = join(project.root, 'receipt.json');
    writeFileSync(path, 'keep this receipt');
    const args = [BIN, '--cwd', project.root, 'export', '--task', 'rollback', '--output', output];
    await expect(execute(process.execPath, [...args, '--receipt', path])).rejects.toMatchObject({
      stderr: expect.stringContaining('already exists'),
    });
    expect(readFileSync(path, 'utf8')).toBe('keep this receipt');
    expect(existsSync(output)).toBe(false);
    await expect(
      execute(process.execPath, [...args, '--receipt', output, '--force']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('must use distinct paths') });
    expect(existsSync(output)).toBe(false);
    await execute(process.execPath, [...args, '--receipt', path, '--force']);
    expect(
      await verifyContextReceipt(JSON.parse(readFileSync(path, 'utf8')), readFileSync(output)),
    ).toBeDefined();
  });
});

it('receipts global JSON stdout even when the requested export format is Markdown', async () => {
  await withTempProject({ files }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const path = join(project.root, 'receipt.json');
    const result = await execute(process.execPath, [
      BIN,
      '--cwd',
      project.root,
      '--json',
      'export',
      '--task',
      'rollback',
      '--format',
      'markdown',
      '--receipt',
      path,
    ]);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    expect(receipt.payloadFormat).toBe('json');
    expect(await verifyContextReceipt(receipt, result.stdout)).toEqual(receipt);
    expect(JSON.parse(result.stdout).buildId).toBe(receipt.buildId);
    expect(readFileSync(path).byteLength).toBeLessThanOrEqual(4096);
  });
});

it('refuses request capture without a receipt destination', async () => {
  await withTempProject({ files }, async (project) => {
    await expect(
      execute(process.execPath, [
        BIN,
        '--cwd',
        project.root,
        'export',
        '--task',
        'rollback',
        '--capture-request',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('--capture-request requires --receipt'),
    });
  });
});
