import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { LoreError } from '@lorepack/core';

const endpoint = process.argv[2];
const token = process.env.LOREPACK_VERIFY_TOKEN;
if (endpoint === undefined || token === undefined || !/^[a-f0-9]{64}$/.test(token)) {
  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    'The verification bridge requires its private host.',
    {
      remediation: 'Run `lorepack connect` rather than the internal bridge entry.',
    },
  );
}
const id = randomBytes(16).toString('hex');
const data = createConnection({ path: endpoint, allowHalfOpen: true });
const stderr = createConnection({ path: endpoint, allowHalfOpen: true });
let dataEnded = false;
let stderrEnded = false;
let stopped = false;
function finish(error?: Error): void {
  if (stopped) return;
  stopped = true;
  if (error !== undefined) process.exitCode = 1;
  process.stdin.unpipe(data);
  process.stdin.destroy();
  data.destroy();
  stderr.destroy();
}
function ended(): void {
  if (dataEnded && stderrEnded) finish();
}
data.once('connect', () => {
  data.write(`${token}:${id}:0\n`);
  process.stdin.pipe(data);
});
stderr.once('connect', () => stderr.write(`${token}:${id}:1\n`));
data.pipe(process.stdout, { end: false });
stderr.pipe(process.stderr, { end: false });
for (const socket of [data, stderr]) socket.on('error', finish);
process.stdin.on('error', finish);
process.stdout.on('error', finish);
process.stderr.on('error', finish);
data.once('end', () => {
  dataEnded = true;
  data.end();
  ended();
});
stderr.once('end', () => {
  stderrEnded = true;
  ended();
});
