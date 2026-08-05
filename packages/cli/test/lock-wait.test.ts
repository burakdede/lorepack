import { DEFAULT_LOCK_WAIT_MS } from '@lorepack/backend-local';
import { describe, expect, it } from 'vitest';
import { lockWaitFromEnvironment } from '../src/services/build.js';
import { ENVIRONMENT_KEYS } from '../src/services/config-resolve.js';

/**
 * `LORE_LOCK_WAIT_MS` (#229).
 *
 * The knob exists because 30 seconds is the right default and the wrong constant to have no
 * way around: it is how long a person will look at a command that appears to be doing nothing,
 * which has nothing to do with how long a large project on a slow disk takes to build.
 *
 * The default itself is asserted here rather than raced against a CI runner's disk, which is
 * what the acceptance scenario used to do.
 */

describe('the lock wait a command will accept', () => {
  it('defaults to thirty seconds when the environment says nothing', () => {
    expect(lockWaitFromEnvironment({})).toBeUndefined();
    // Undefined means "use the shipped default", so the default is what it resolves to.
    expect(DEFAULT_LOCK_WAIT_MS).toBe(30_000);
  });

  it('takes a number of milliseconds', () => {
    expect(lockWaitFromEnvironment({ LORE_LOCK_WAIT_MS: '300000' })).toBe(300_000);
    // Zero is a real answer: do not wait, fail immediately if the lock is held.
    expect(lockWaitFromEnvironment({ LORE_LOCK_WAIT_MS: '0' })).toBe(0);
  });

  /**
   * The trap #195 found on a different knob, checked here before it can be found again.
   *
   * `Number('')` is 0, an unset variable expands to the empty string in a shell, and 0 here
   * means "do not wait at all": the opposite of what someone setting a wait wants, reached by
   * writing nothing.
   */
  it('refuses an empty value rather than reading it as do-not-wait', () => {
    expect(() => lockWaitFromEnvironment({ LORE_LOCK_WAIT_MS: '' })).toThrowError(
      /LORE_LOCK_WAIT_MS must be a number/,
    );
    expect(() => lockWaitFromEnvironment({ LORE_LOCK_WAIT_MS: '   ' })).toThrowError(
      /LORE_LOCK_WAIT_MS must be a number/,
    );
  });

  it('refuses a value that is not a non-negative number', () => {
    for (const raw of ['soon', '-1', 'NaN', '30s']) {
      expect(() => lockWaitFromEnvironment({ LORE_LOCK_WAIT_MS: raw })).toThrowError(
        /LORE_LOCK_WAIT_MS must be a number/,
      );
    }
  });

  it('is listed among the documented environment keys, so `lore config` shows it', () => {
    // An override channel nothing reports is an override channel nobody finds.
    expect(ENVIRONMENT_KEYS).toContain('LORE_LOCK_WAIT_MS');
  });
});
