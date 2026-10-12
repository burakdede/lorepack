import { rmSync } from 'node:fs';
import { verifyContextReceipt } from '@lorepack/core';
import { expect, it } from 'vitest';
import { createCloudflareWorkerFromBindings } from '../src/index.js';
import {
  ACTIVE_BUILD,
  activateProjectedWorkerRuntimeFixture,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from './projected-runtime-fixture.js';

it.each(['http', 'mcp'])(
  'verifies detached %s receipts from source-free Worker projection, issue434',
  async (transport) => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    const worker = createCloudflareWorkerFromBindings(
      {
        CATALOG_DB: fixture.projection,
        TABLES_DB: fixture.projection,
        OBJECTS: fixture.bucket,
        PROJECT_ID: PROJECT,
      },
      { allowedOrigins: ['https://app.example'] },
    );
    try {
      rmSync(fixture.buildDirectory, { recursive: true });
      await activateProjectedWorkerRuntimeFixture();
      for (const captureRequest of [false, true]) {
        const args = {
          task: fixture.matchingQuery,
          buildId: ACTIVE_BUILD,
          budget: 4000,
          receipt: { captureRequest },
        };
        const response = await worker.fetch(
          new Request(`https://worker.example/${transport === 'http' ? 'v1/context' : 'mcp'}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              Origin: 'https://app.example',
            },
            body: JSON.stringify(
              transport === 'http'
                ? args
                : {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'lore_context_for_task', arguments: args },
                  },
            ),
          }),
        );
        expect(response.status).toBe(200);
        const emitted = await response.text();
        let payload: string;
        let receipt: unknown;
        if (transport === 'http') {
          payload = emitted;
          const header = response.headers.get('Lorepack-Context-Receipt');
          expect(header).not.toBeNull();
          receipt = JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8'));
          expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
            'Lorepack-Context-Receipt',
          );
        } else {
          const frame = emitted.startsWith('event:')
            ? JSON.parse(
                (emitted.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(6),
              )
            : JSON.parse(emitted);
          expect(frame.result.isError).not.toBe(true);
          payload = JSON.stringify({
            content: frame.result.content,
            structuredContent: frame.result.structuredContent,
          });
          receipt = frame.result._meta['lorepack.dev/context-receipt'];
        }
        const verified = await verifyContextReceipt(receipt, payload);
        expect(verified.buildId).toBe(ACTIVE_BUILD);
        expect(verified.requestRetained).toBe(captureRequest);
        expect(payload).not.toContain('tell the team what changed');
        expect(verified.payloadRetained).toBe(false);
        await expect(verifyContextReceipt(receipt, `${payload}\n`)).rejects.toMatchObject({
          code: 'LORE_E_SCHEMA_MISMATCH',
        });
      }
    } finally {
      worker.close();
      await fixture.close();
    }
  },
);
