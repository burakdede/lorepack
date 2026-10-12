import { expect, it } from 'vitest';
import { hashCanonical } from '../src/hash/canonical.js';
import { hashCanonicalPortable } from '../src/worker.js';

it('uses identical canonical SHA-256 bytes in Node and portable execution, issue693', async () => {
  for (const value of [
    null,
    true,
    3.6,
    'checkpoint 🧭',
    ['ab', 'c'],
    { b: false, a: 'checkpoint' },
  ]) {
    expect(await hashCanonicalPortable(value)).toBe(hashCanonical(value));
  }
  expect(await hashCanonicalPortable({ a: 'checkpoint', b: false })).toBe(
    await hashCanonicalPortable({ b: false, a: 'checkpoint' }),
  );
  expect(await hashCanonicalPortable(['ab', 'c'])).not.toBe(
    await hashCanonicalPortable(['a', 'bc']),
  );
});
