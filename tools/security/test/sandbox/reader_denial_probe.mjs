import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isMainThread, Worker, workerData } from 'node:worker_threads';

const parser = /parse-child\.js$/.test(process.argv[1] ?? '');
if (parser || (!isMainThread && workerData?.role === 'lorepack-linux-resident-reader')) {
  process.stderr.write(
    parser
      ? 'LORE_NESTED_PARSER_PROBE worker_threads.Worker\n'
      : 'LORE_NESTED_READER_PROBE worker_threads.Worker\n',
  );
  assert.throws(() => new Worker('0', { eval: true }), { code: 'ERR_ACCESS_DENIED' });
  if (!parser) {
    assert.throws(() => spawnSync(process.execPath, ['--version']), { code: 'ERR_ACCESS_DENIED' });
    assert.throws(() => process.kill(process.pid, 0), { code: 'ERR_ACCESS_DENIED' });
  }
}
