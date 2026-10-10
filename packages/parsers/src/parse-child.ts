import type { ParseInput } from '@lorepack/core';
import { type ChildReply, serializeError } from './isolation-protocol.js';
import { PARSERS } from './registry-parsers.js';

/**
 * The process a parse runs in. See `isolation.ts` for why it is a process.
 *
 * It holds no state between jobs beyond the modules it loaded, which is the same promise a
 * parser makes in-process: one parse cannot see another's input.
 */

const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error('parse-child.js must be started by ParserHost, with an IPC channel.');
}
const reply = (message: ChildReply): void => {
  send(message);
};

process.on('message', (job: { readonly parserId: string; readonly input: ParseInput }) => {
  void run(job);
});

// The parent closing the channel means it is gone or finished with us. Waiting for the next
// job would leave an orphan holding memory until the operating system reclaims it.
process.on('disconnect', () => {
  process.exit(0);
});

async function run(job: { readonly parserId: string; readonly input: ParseInput }): Promise<void> {
  const parser = PARSERS.find((candidate) => candidate.id === job.parserId);
  try {
    if (parser === undefined) throw new Error(`No registered parser has the id ${job.parserId}.`);
    reply({ kind: 'parsed', result: await parser.parse(job.input) });
  } catch (error) {
    reply({ kind: 'failed', error: serializeError(error) });
  }
}

reply({ kind: 'ready' });
