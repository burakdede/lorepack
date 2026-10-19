import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { MessageChannel, Worker } from 'node:worker_threads';

const helper = new URL(
  '../../../../packages/cli/dist/linux_resident_reader_worker.js',
  import.meta.url,
);
const fork = childProcess.fork;
let exercised = false;
childProcess.fork = function (...args) {
  const child = fork.apply(this, args);
  if (exercised) return child;
  exercised = true;
  const { port1, port2 } = new MessageChannel();
  try {
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    assert.ok(Buffer.byteLength(stat) <= 4096);
    const start = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    assert.match(start, /^[0-9]{1,20}$/);
    const data = {
      role: 'lorepack-linux-resident-reader',
      pid: child.pid,
      limitMiB: 1024,
      expectedBirth: `${child.pid}:${start}`,
      generation: 1,
      shared: new SharedArrayBuffer(32),
      port: port2,
    };
    const options = { execArgv: [], workerData: data, transferList: [port2] };
    const variants = [
      ['wrong path', new URL('./reader_admission_probe.mjs', import.meta.url), options],
      ['data URL', new URL('data:text/javascript,0'), options],
      ['eval', '0', { ...options, eval: true }],
      ['extra env', helper, { ...options, env: { ...process.env } }],
      ['altered execArgv', helper, { ...options, execArgv: ['--allow-child-process'] }],
      ['spoofed role', helper, { ...options, workerData: { ...data, role: 'other' } }],
      ['foreign PID', helper, { ...options, workerData: { ...data, pid: process.pid } }],
      [
        'mismatched birth PID',
        helper,
        { ...options, workerData: { ...data, expectedBirth: `${process.pid}:1` } },
      ],
      ['altered URL', new URL(`${helper.href}?other`), options],
      [
        'wrong shared layout',
        helper,
        { ...options, workerData: { ...data, shared: new SharedArrayBuffer(8) } },
      ],
      ['wrong port transfer', helper, { ...options, transferList: [] }],
    ];
    for (const [name, filename, settings] of variants) {
      let unexpected;
      try {
        assert.throws(
          () => {
            unexpected = new Worker(filename, settings);
            unexpected.on('error', () => {});
          },
          { code: 'ERR_ACCESS_DENIED' },
          name,
        );
      } finally {
        if (unexpected) void unexpected.terminate();
      }
    }
    process.stderr.write('LORE_READER_ADMISSION_PROOF\n');
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    port1.close();
    port2.close();
  }
  return child;
};
syncBuiltinESMExports();
