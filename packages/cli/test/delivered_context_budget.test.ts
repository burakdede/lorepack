import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { estimateTokens } from '@lorepack/compiler';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { startServing } from '../src/services/serving.js';
import { withObserverDiagnostic } from './support/observer_diagnostic.js';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

it.each(['json', 'markdown', 'http', 'mcp'])(
  'bounds complete %s output including omissions and framing, issue424',
  async (format) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: delivered-budget\nsources: [docs]\n',
          ...Object.fromEntries(
            Array.from({ length: 70 }, (_, index) => [
              `docs/policy-${String(index).padStart(3, '0')}.md`,
              `# Policy ${index}\n\n${Array.from({ length: 90 }, (_, word) => `permission${index}item${word}`).join(' ')}\n`,
            ]),
          ),
        },
      },
      async (project) => {
        await withObserverDiagnostic(process.platform === 'win32' && format === 'json', () =>
          runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() }),
        );
        let payload: string;
        if (format === 'json' || format === 'markdown') {
          const result = await execute(
            process.execPath,
            [
              BIN,
              '--cwd',
              project.root,
              'export',
              '--task',
              'policy',
              '--profile',
              'agent',
              '--budget',
              '4000',
              '--format',
              format,
            ],
            { timeout: 30_000 },
          );
          payload = result.stdout;
        } else {
          const server = await startServing({
            config: loadConfig({ cwd: project.root }),
            host: '127.0.0.1',
            port: 47_995,
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
                    ? { task: 'policy', budget: 4000 }
                    : {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/call',
                        params: {
                          name: 'lore_context_for_task',
                          arguments: { task: 'policy', budget: 4000 },
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
              payload = JSON.stringify(result);
            }
          } finally {
            await server.close();
          }
        }
        expect(payload).toContain('permission');
        expect(
          estimateTokens(payload),
          `${format}: complete emitted payload must fit4000 estimated tokens`,
        ).toBeLessThanOrEqual(4000);
        expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
      },
    );
  },
  120_000,
);
