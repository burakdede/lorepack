import { describe, expect, it } from 'vitest';
import { exitAfterFlush, type FlushableStream, flushStream } from '../src/framework/exit.js';

/**
 * The regression tests for #154.
 *
 * `lore --json inspect sources` returned exactly 65536 bytes through a pipe and 521709 to a
 * file, because `process.exit` discards whatever is still queued on an asynchronous stream.
 * The consumer got a plausible prefix of a real answer at exit code 0, which is worse than
 * getting nothing.
 */

/** A stream that queues writes and only drains when told to, the way a pipe behaves. */
class SlowStream implements FlushableStream {
  written = '';
  writableLength = 0;
  writableEnded = false;
  #pending: Array<() => void> = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.written += chunk;
    this.writableLength += chunk.length;
    if (callback !== undefined) this.#pending.push(() => callback(null));
    return false;
  }

  /** What a reader on the other end of the pipe eventually does. */
  drain(): void {
    this.writableLength = 0;
    const pending = this.#pending;
    this.#pending = [];
    for (const resolve of pending) resolve();
  }

  get waiting(): number {
    return this.#pending.length;
  }
}

describe('flushStream', () => {
  it('waits for a queued write to drain before resolving', async () => {
    const stream = new SlowStream();
    stream.write('a lot of output');

    let resolved = false;
    const flushed = flushStream(stream).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved, 'resolved while the stream still had queued bytes').toBe(false);

    stream.drain();
    await flushed;
    expect(resolved).toBe(true);
  });

  it('returns immediately when nothing is queued', async () => {
    const stream = new SlowStream();
    await flushStream(stream);
    expect(stream.waiting).toBe(0);
  });

  it('returns immediately when the stream is already ended', async () => {
    const stream = new SlowStream();
    stream.write('queued');
    stream.writableEnded = true;

    // No drain, and no hang: an ended stream has nothing left to wait for.
    await flushStream(stream);
  });

  it('gives up on a stream nobody is reading, rather than hanging forever', async () => {
    // `lore --json ... | head -1` closes the reader while the writer still has bytes
    // queued. A CLI that waited forever to say goodbye would be a worse bug than the one
    // the flush exists to fix.
    const stream = new SlowStream();
    stream.write('into the void');

    await flushStream(stream, 10);
  });

  it('survives a stream that throws on write', async () => {
    const hostile: FlushableStream = {
      writableLength: 5,
      write() {
        throw new Error('EPIPE');
      },
    };

    await flushStream(hostile, 50);
  });
});

describe('exitAfterFlush', () => {
  it('flushes both streams before exiting, and exits with the code it was given', async () => {
    const stdout = new SlowStream();
    const stderr = new SlowStream();
    stdout.write('the structured result');
    stderr.write('progress and warnings');

    const exits: number[] = [];
    const exiting = exitAfterFlush(7, { stdout, stderr }, ((code: number) => {
      exits.push(code);
      return undefined as never;
    }) as (code: number) => never);

    await Promise.resolve();
    expect(exits, 'exited before the streams had drained').toEqual([]);

    stdout.drain();
    stderr.drain();
    await exiting;

    expect(exits).toEqual([7]);
  });
});
