import { parentPort, workerData } from 'node:worker_threads';
import { LoreError, ProgressBus } from '@lorepack/core';
import type { BuildWorkerInput, BuildWorkerReply } from './background_build.js';
import { runBuild } from './build.js';

if (parentPort === null) {
  throw new LoreError('LORE_E_INTERNAL', 'The build worker requires a parent.', {
    remediation: 'Run `lorepack dev` rather than the internal worker entry.',
  });
}
const port = parentPort;
const input = workerData as BuildWorkerInput;
const controller = new AbortController();
port.on('message', (message: { kind: 'abort' }) => {
  if (message.kind === 'abort') controller.abort();
});
const reply = (message: BuildWorkerReply) => port.postMessage(message);
const progress = new ProgressBus();
progress.subscribe((event) => reply({ kind: 'progress', event }));
try {
  const result = await runBuild({ ...input, progress, signal: controller.signal });
  reply({ kind: 'built', result });
} catch (error) {
  reply({
    kind: 'failed',
    error,
    ...(error instanceof LoreError
      ? {
          lore: {
            code: error.code,
            remediation: error.remediation,
            path: error.path,
            subject: error.subject,
            details: error.details,
          },
        }
      : {}),
  });
} finally {
  port.close();
}
