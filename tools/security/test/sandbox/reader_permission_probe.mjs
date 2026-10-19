import assert from 'node:assert/strict';
import { isMainThread, workerData } from 'node:worker_threads';

if (!isMainThread && workerData?.role === 'lorepack-linux-resident-reader') {
  assert.ok(process.permission);
  assert.equal(process.permission.has('fs.read'), true);
  for (const permission of ['fs.write', 'child', 'worker', 'addons', 'wasi']) {
    assert.equal(process.permission.has(permission), false, permission);
  }
  process.stderr.write('LORE_READER_PERMISSION_PROOF\n');
}
