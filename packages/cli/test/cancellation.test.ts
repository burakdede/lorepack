import { describe, expect, it } from 'vitest';
import { checkpoint } from '../src/services/cancellation.js';

/**
 * The regression tests for #146.
 *
 * The defect was not that the checkpoints read the flag wrongly. They read it correctly and
 * were never reached, because the build never returned to the event loop and so the signal
 * handler that sets the flag never ran. A test that aborts the controller itself cannot see
 * that: it proves the flag is read, which was never in doubt.
 *
 * So the property pinned here is the yield, directly. A macrotask scheduled before the
 * checkpoint must have run by the time it resolves. `queueMicrotask` would fail this,
 * which is the whole point.
 */
describe('checkpoint', () => {
  it('completes a turn of the event loop, which is what lets a signal arrive', async () => {
    let ranOnTheEventLoop = false;
    setImmediate(() => {
      ranOnTheEventLoop = true;
    });

    await checkpoint(new AbortController().signal);

    expect(ranOnTheEventLoop, 'checkpoint returned without yielding to the event loop').toBe(true);
  });

  it('throws a typed, remediable error once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(checkpoint(controller.signal)).rejects.toMatchObject({
      code: 'LORE_E_CANCELLED',
      remediation: expect.stringContaining('Nothing was changed.'),
    });
  });

  it('observes an abort that happens while it is yielding', async () => {
    const controller = new AbortController();
    // Scheduled after the checkpoint's own immediate, so it runs during the yield rather
    // than before it: the ordering a real signal has.
    setImmediate(() => controller.abort());

    await expect(checkpoint(controller.signal)).rejects.toMatchObject({
      code: 'LORE_E_CANCELLED',
    });
  });

  it('does nothing at all without a signal, so an uncancellable caller pays no cost', async () => {
    let ranOnTheEventLoop = false;
    setImmediate(() => {
      ranOnTheEventLoop = true;
    });

    await checkpoint(undefined);

    expect(ranOnTheEventLoop).toBe(false);
  });
});

describe('what an interrupted build tells the user', () => {
  /**
   * #168: the remediation always said "the previously active build is still serving",
   * including on the first build in a project, where there is nothing serving at all. That
   * is the most likely build to be interrupted, and a new user is the least equipped to
   * know the sentence is false.
   */
  const aborted = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };

  it('says the previous build is still serving when there is one', async () => {
    await expect(checkpoint(aborted(), { hasActiveBuild: true })).rejects.toMatchObject({
      code: 'LORE_E_CANCELLED',
      remediation: expect.stringContaining('previously active build'),
    });
  });

  it('says the project still has no build when it does not', async () => {
    await expect(checkpoint(aborted(), { hasActiveBuild: false })).rejects.toMatchObject({
      remediation: expect.stringContaining('no build'),
    });
  });

  it('claims nothing about a previous build when the caller did not say', async () => {
    await expect(checkpoint(aborted())).rejects.toMatchObject({
      remediation: expect.not.stringContaining('still serving'),
    });
  });
});
