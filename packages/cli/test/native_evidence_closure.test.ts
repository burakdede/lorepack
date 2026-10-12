import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { estimateTokens } from '@lorepack/compiler';
import { loadConfig, loadProjectConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { startServing } from '../src/services/serving.js';

const PERMISSION = 'ZX-88 permits emergency rollback.';
const QUALIFICATION =
  'ZX-88 is permitted only if owner approval is recorded; do not waive approval.';
const PARAGRAPH = `${PERMISSION} ${'Review the operational conditions carefully. '.repeat(120)}${QUALIFICATION}`;

it('omits a complete native unit when delivered framing cannot fit the budget, issue698', async () => {
  const body = `${PERMISSION} ${'Review the operational conditions carefully. '.repeat(400)}${QUALIFICATION}`;
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: native\nsources: [docs]\n',
        'docs/policy.md': `# Exception ZX-88\n\n${body}\n`,
      },
    },
    async (project) => {
      await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const runtime = createRuntime(backend);
        const bounded = await runtime.contextForTask({
          task: 'ZX-88 emergency rollback',
          budget: 4000,
        });
        expect([...bounded.overview, ...bounded.selected, ...bounded.alternatives]).toEqual([]);
        expect(bounded.omissionSummary.reasons.budget).toBeGreaterThan(0);
        expect(bounded.omissionSummary.reasons['structural-unit']).toBe(0);
        expect(bounded.estimatedTokens).toBeLessThanOrEqual(4000);
        const admitted = await runtime.contextForTask({
          task: 'ZX-88 emergency rollback',
          budget: 40000,
        });
        const selected = [...admitted.overview, ...admitted.selected];
        expect(selected.length).toBeGreaterThan(0);
        for (const item of selected) expect(item.text).toContain(body);
        expect(admitted.estimatedTokens).toBeLessThanOrEqual(40000);
      } finally {
        backend.close();
      }
    },
  );
});

it('retains the native table header and attached definition across retrieval chunks, issue698', async () => {
  const header = 'Permission definition';
  const definition = 'Permitted means owner approval is recorded; do not waive approval.';
  const table = [
    `| Rule | ${header} |`,
    '| --- | --- |',
    '| ZX-88 | permits emergency rollback |',
    ...Array.from(
      { length: 100 },
      (_, index) => `| Check ${index} | Review operational conditions carefully |`,
    ),
    `| Definition | ${definition} |`,
  ].join('\n');
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: native\nsources: [docs]\n',
        'docs/policy.md': `# Exception policy\n\n${table}\n`,
      },
    },
    async (project) => {
      const built = await runBuild({
        config: loadConfig({ cwd: project.root }),
        progress: new ProgressBus(),
      });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const bundle = await createRuntime(backend).contextForTask({
          task: 'ZX-88 emergency rollback',
          budget: 16000,
          buildId: built.buildId,
        });
        const items = [...bundle.overview, ...bundle.selected].filter((item) =>
          item.text.includes('ZX-88'),
        );
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
          expect(item.text).toContain(header);
          expect(item.text).toContain(definition);
          expect(item.nativeUnit?.status).toBe('complete');
          expect(item.locator.lineEnd).toBe(106);
        }
      } finally {
        backend.close();
      }
    },
  );
});

it.each([4000, 8000])(
  'keeps native permission and attached negation together at budget %i, issue698',
  async (budget) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: native\nsources: [docs]\n',
          'docs/policy.md': `# Exception ZX-88\n\n${PARAGRAPH}\n`,
        },
      },
      async (project) => {
        const built = await runBuild({
          config: loadConfig({ cwd: project.root }),
          progress: new ProgressBus(),
        });
        project.write(
          'docs/policy.md',
          '# Changed policy\n\nA different permission for build B.\n',
        );
        const next = await runBuild({
          config: loadConfig({ cwd: project.root }),
          progress: new ProgressBus(),
        });
        expect(next.buildId).not.toBe(built.buildId);
        rmSync(project.path('docs'), { recursive: true });
        const backend = createLocalRuntimeBackend({ projectRoot: project.root });
        try {
          const bundle = await createRuntime(backend).contextForTask({
            task: 'ZX-88 emergency rollback',
            budget,
            buildId: built.buildId,
          });
          expect(bundle.buildId).toBe(built.buildId);
          const permission = [...bundle.overview, ...bundle.selected].filter((item) =>
            item.text.includes(PERMISSION),
          );
          if (budget === 8000) expect(permission.length).toBeGreaterThan(0);
          if (permission.length === 0) {
            expect(
              bundle.omissionSummary.reasons.budget +
                bundle.omissionSummary.reasons['structural-unit'],
            ).toBeGreaterThan(0);
          }
          expect(bundle.estimatedTokens).toBeLessThanOrEqual(budget);
          for (const item of permission) {
            expect(
              item.text,
              'Selected permission must retain the attached only-if/not condition.',
            ).toContain(QUALIFICATION);
            expect(item.text).toContain(PARAGRAPH);
            expect(item.locator.relativePath).toBe('policy.md');
          }
        } finally {
          backend.close();
        }
      },
    );
  },
);

it.each(['json', 'markdown', 'http', 'mcp'])(
  'preserves attached qualification through complete %s output, issue698',
  async (format) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: native\nsources: [docs]\n',
          'docs/policy.md': `# Exception ZX-88\n\n${PARAGRAPH}\n`,
        },
      },
      async (project) => {
        const built = await runBuild({
          config: loadConfig({ cwd: project.root }),
          progress: new ProgressBus(),
        });
        rmSync(project.path('docs'), { recursive: true });
        let payload: string;
        if (format === 'json' || format === 'markdown') {
          const result = await promisify(execFile)(
            process.execPath,
            [
              join(import.meta.dirname, '..', 'dist', 'public-entry.js'),
              '--cwd',
              project.root,
              'export',
              '--build',
              built.buildId,
              '--task',
              'ZX-88 emergency rollback',
              '--budget',
              '8000',
              '--format',
              format,
            ],
            { timeout: 30_000 },
          );
          payload = result.stdout;
        } else {
          const port = await new Promise<number>((resolve, reject) => {
            const socket = createServer();
            socket.on('error', reject);
            socket.listen(0, '127.0.0.1', () => {
              const address = socket.address();
              if (address === null || typeof address === 'string') {
                socket.close();
                reject(new Error('Expected a TCP address.'));
                return;
              }
              socket.close(() => resolve(address.port));
            });
          });
          const server = await startServing({
            config: loadProjectConfig({ cwd: project.root }),
            buildId: built.buildId,
            host: '127.0.0.1',
            port,
            warn: () => {},
          });
          try {
            const response = await fetch(
              `${server.url}/${format === 'http' ? 'v1/context' : 'mcp'}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify(
                  format === 'http'
                    ? { task: 'ZX-88 emergency rollback', budget: 8000 }
                    : {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/call',
                        params: {
                          name: 'lore_context_for_task',
                          arguments: { task: 'ZX-88 emergency rollback', budget: 8000 },
                        },
                      },
                ),
              },
            );
            expect(response.status).toBe(200);
            const raw = await response.text();
            if (format === 'http') payload = raw;
            else {
              const frames =
                raw.startsWith('data:') || raw.includes('\ndata:')
                  ? raw
                      .split('\n')
                      .filter((line) => line.startsWith('data:'))
                      .map((line) => JSON.parse(line.slice(5)))
                  : [JSON.parse(raw)];
              const result = frames.find((frame) => frame.id === 1)?.result;
              expect(result).toBeDefined();
              expect(result.isError).not.toBe(true);
              expect(result.structuredContent.buildId).toBe(built.buildId);
              const selected = [
                ...result.structuredContent.overview,
                ...result.structuredContent.selected,
              ];
              expect(selected.some((item) => item.text.includes(PARAGRAPH))).toBe(true);
              payload = JSON.stringify(result);
            }
          } finally {
            await server.close();
          }
        }
        expect(payload).toContain(PERMISSION);
        expect(payload).toContain(QUALIFICATION);
        expect(payload).toContain(built.buildId);
        expect(estimateTokens(payload)).toBeLessThanOrEqual(8000);
      },
    );
  },
  60_000,
);
