/**
 * Ending the process without losing what it just said.
 *
 * `process.exit` is documented to terminate "as soon as possible", and on a pipe that is
 * sooner than the writes have drained: `process.stdout` is asynchronous when it is a pipe
 * and synchronous when it is a file or a TTY. So `lore --json inspect sources` returned
 * exactly 65536 bytes through `| jq` and the full 521709 to a redirect, with exit code 0
 * and no error either side (#154). A consumer got a plausible prefix of a real answer,
 * which is worse than getting nothing.
 *
 * The cure is to wait for both streams to drain first. `write('')` invokes its callback
 * once everything queued ahead of it has been flushed, which is exactly the point we need,
 * and costs nothing when the queue is already empty.
 *
 * The timeout is not decoration. A pipe whose reader has gone away, `| head -1` being the
 * everyday case, never drains, and a CLI that hangs forever waiting to say goodbye would be
 * a worse bug than the one this fixes.
 */

export interface FlushableStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  readonly writableLength?: number;
  readonly writableEnded?: boolean;
}

/** How long to wait for a stream nobody is reading before giving up on it. */
export const FLUSH_TIMEOUT_MS = 2_000;

export async function flushStream(
  stream: FlushableStream,
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (stream.writableEnded === true) return;
  if (typeof stream.writableLength === 'number' && stream.writableLength === 0) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    // Node keeps the process alive for a pending timer, and this one exists only to bound
    // the wait, so it must not be a reason to stay up.
    timer.unref?.();

    try {
      stream.write('', finish);
    } catch {
      // A stream that refuses the write has nothing left to flush.
      finish();
    }
  });
}

/**
 * Flushes both streams, then exits. Every exit path in the CLI goes through here, including
 * the second-interrupt path, which still ends promptly: it is the timeout, not the drain,
 * that bounds how long "promptly" can be.
 */
export async function exitAfterFlush(
  code: number,
  streams: { stdout: FlushableStream; stderr: FlushableStream },
  exit: (code: number) => never = process.exit as (code: number) => never,
): Promise<never> {
  await Promise.all([flushStream(streams.stdout), flushStream(streams.stderr)]);
  return exit(code);
}
