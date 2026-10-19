import { MessagePort, workerData } from 'node:worker_threads';
import { serializeError } from './isolation-protocol.js';
import {
  LINUX_READER_SHARED_BYTES,
  type LinuxReaderData,
  type LinuxReaderPayload,
  type LinuxReaderRequest,
  pollLinuxResidentMemory,
} from './linux_resident_reader.js';

const data = workerData as LinuxReaderData;
if (
  process.platform !== 'linux' ||
  data?.role !== 'lorepack-linux-resident-reader' ||
  !Number.isSafeInteger(data.pid) ||
  data.pid <= 0 ||
  typeof data.expectedBirth !== 'string' ||
  data.expectedBirth.length > 64 ||
  !/^\d{1,10}:\d{1,20}$/.test(data.expectedBirth) ||
  !data.expectedBirth.startsWith(`${data.pid}:`) ||
  !Number.isSafeInteger(data.generation) ||
  data.generation <= 0 ||
  !Number.isInteger(data.limitMiB) ||
  data.limitMiB < 64 ||
  data.limitMiB > 32768 ||
  !(data.shared instanceof SharedArrayBuffer) ||
  data.shared.byteLength !== LINUX_READER_SHARED_BYTES ||
  !(data.port instanceof MessagePort)
)
  throw new Error('Invalid Linux resident-memory reader owner.');
const state = new BigInt64Array(data.shared);
const send = (message: LinuxReaderPayload) =>
  data.port.postMessage({ ...message, generation: data.generation });
const terminal = (kind: bigint, error?: unknown) => {
  if (Atomics.compareExchange(state, 2, 0n, kind) !== 0n) return;
  send(
    error === undefined ? { kind: 'terminal' } : { kind: 'terminal', error: serializeError(error) },
  );
};
const reader = pollLinuxResidentMemory(
  data.pid,
  {
    sample(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        terminal(1n, new Error('The operating system returned an invalid resident size.'));
        reader.stop();
        return;
      }
      Atomics.store(state, 0, BigInt(bytes));
      Atomics.add(state, 1, 1n);
      if (bytes > data.limitMiB * 1024 * 1024) {
        terminal(2n);
        reader.stop();
      } else if (Atomics.compareExchange(state, 3, 0n, 1n) === 0n) send({ kind: 'sample' });
    },
    error(cause) {
      terminal(1n, cause);
    },
    gone(reason) {
      terminal(reason === 'identity-mismatch' ? 4n : 3n);
    },
  },
  data.expectedBirth,
);
data.port.on('message', (request: LinuxReaderRequest) => {
  if (request.generation !== data.generation) return;
  if (request.kind === 'barrier') send({ kind: 'barrier', id: request.id });
  else {
    reader.stop();
    void reader.closed.then(() => {
      send({ kind: 'closed' });
      data.port.close();
    });
  }
});
data.port.once('close', () => reader.stop());
send({ kind: 'ready' });
