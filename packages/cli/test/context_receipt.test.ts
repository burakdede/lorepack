import { createHash } from 'node:crypto';
import { estimateTokens } from '@lorepack/compiler';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { startServing } from '../src/services/serving.js';

it.each(['http', 'mcp'])(
  'returns an opt-in detached receipt for exact %s context bytes, issue434',
  async (transport) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: receipt-proof\nsources: [docs]\n',
          'docs/policy.md': '# Rollback\n\nRollback needs owner approval. Preserve café and 🧭.\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        await runBuild({ config, progress: new ProgressBus() });
        const server = await startServing({
          config,
          host: '127.0.0.1',
          port: 47987,
          warn: () => {},
        });
        try {
          const response = await fetch(
            `${server.url}/${transport === 'http' ? 'v1/context' : 'mcp'}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
              },
              body: JSON.stringify(
                transport === 'http'
                  ? { task: 'rollback', receipt: true, budget: 4000 }
                  : {
                      jsonrpc: '2.0',
                      id: 1,
                      method: 'tools/call',
                      params: {
                        name: 'lore_context_for_task',
                        arguments: { task: 'rollback', receipt: true, budget: 4000 },
                      },
                    },
              ),
            },
          );
          expect(response.status).toBe(200);
          const emitted = await response.text();
          let raw: string;
          let receipt: Record<string, unknown>;
          if (transport === 'http') {
            raw = emitted;
            const header = response.headers.get('Lorepack-Context-Receipt');
            expect(header).not.toBeNull();
            receipt = JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8'));
          } else {
            const frames = emitted
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => JSON.parse(line.slice(5)));
            const result = (
              frames.length === 0 ? JSON.parse(emitted) : frames.find((frame) => frame.id === 1)
            ).result;
            expect(result.isError).not.toBe(true);
            receipt = result._meta['lorepack.dev/context-receipt'];
            raw = JSON.stringify({
              content: result.content,
              structuredContent: result.structuredContent,
            });
            expect(estimateTokens(JSON.stringify(result))).toBeLessThanOrEqual(4000);
            expect(
              result.structuredContent.execution.policy.serialization.receipt.maximumBytes,
            ).toBe(4096);
          }
          expect(receipt.boundary).toBe('lorepack-emitted-content');
          expect(receipt.buildId).toBe(
            transport === 'http'
              ? JSON.parse(raw).buildId
              : JSON.parse(raw).structuredContent.buildId,
          );
          expect(receipt.payloadDigest).toBe(createHash('sha256').update(raw).digest('hex'));
          expect(receipt.payloadBytes).toBe(Buffer.byteLength(raw, 'utf8'));
          expect(receipt.payloadRetained).toBe(false);
          expect(receipt.requestRetained).toBe(false);
          expect(receipt.request).toBeUndefined();
          expect(JSON.parse(raw).receipt).toBeUndefined();

          const ordinary = await fetch(`${server.url}/v1/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: 'rollback' }),
          });
          expect(ordinary.status).toBe(200);
          expect(ordinary.headers.has('Lorepack-Context-Receipt')).toBe(false);
        } finally {
          await server.close();
        }
      },
    );
  },
);
