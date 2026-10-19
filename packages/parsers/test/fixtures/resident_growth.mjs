import { performance } from 'node:perf_hooks';

const held = [];
process.on('message', (message) => {
  if (message !== 'grow') return;
  const startedAt = Date.now();
  const started = performance.now();
  for (let index = 0; index < 8; index++) {
    held.push(Buffer.alloc(16 * 1024 * 1024, index + 1));
    const until = performance.now() + 100;
    while (performance.now() < until) {}
  }
  process.send?.({
    kind: 'grown',
    startedAt,
    finishedAt: Date.now(),
    blockedMs: performance.now() - started,
  });
});
process.send?.({ kind: 'ready' });
