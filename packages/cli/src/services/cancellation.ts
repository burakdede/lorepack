import { LoreError } from '@lorepack/core';

/**
 * A cancellation checkpoint: give the process a chance to hear the signal, then honour it.
 *
 * The yield is the load-bearing half, and its absence was #146.
 *
 * Node delivers signals from the event loop, but a build stage can run without ever
 * reaching it. `await` only suspends until a promise settles, and every promise awaited in
 * the parse loop is settled already: `FileObjectStore` is asynchronous in signature and
 * synchronous inside. The whole stage therefore runs as one unbroken chain of microtasks,
 * the loop is never reached, the SIGINT handler never runs, and `signal.aborted` stays
 * false however often it is read. The checkpoints were correct and unreachable, which is
 * why a test that set the flag itself passed while Ctrl-C did nothing at all.
 *
 * `setImmediate` rather than `queueMicrotask`: only a full turn of the loop lets libuv
 * deliver a pending signal. It costs microseconds against work measured in milliseconds per
 * artifact, and a 500 document corpus builds no slower with it than without.
 *
 * Cancellation is therefore granular to the checkpoints, not to the instant: a signal that
 * arrives inside one long synchronous call, such as writing the catalog, is honoured at the
 * next checkpoint rather than immediately. What the guarantee promises is that `builds/`
 * and the active pointer are unchanged, and a checkpoint before every write is enough for
 * that.
 */
export async function checkpoint(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return;
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  if (!signal.aborted) return;
  throw new LoreError('LORE_E_CANCELLED', 'The build was cancelled.', {
    remediation: 'Nothing was changed. The previously active build is still serving.',
  });
}
