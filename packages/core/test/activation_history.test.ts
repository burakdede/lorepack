import { describe, expect, it } from 'vitest';
import { previousActivation } from '../src/activation_history.js';
import type { BuildId } from '../src/hash/id.js';
import type { ActivationEvent } from '../src/ports/storage.js';

const A = `lore_${'a'.repeat(64)}` as BuildId;
const C = `lore_${'c'.repeat(64)}` as BuildId;
const active = { buildId: C, generation: 4 };
const transition: ActivationEvent = {
  generation: 4,
  previousBuildId: A,
  buildId: C,
  kind: 'transition',
  recordedAt: '2026-01-01T00:00:00.000Z',
};

describe('previous activation selection', () => {
  it('returns the actual predecessor across legitimate no-op generation gaps', () => {
    expect(previousActivation(active, transition)).toBe(A);
    expect(previousActivation({ ...active, generation: 8 }, transition)).toBe(A);
  });
  it.each([
    { pointer: null, latest: transition },
    { pointer: active, latest: undefined },
    {
      pointer: active,
      latest: { ...transition, kind: 'baseline' as const, previousBuildId: null },
    },
    { pointer: active, latest: { ...transition, previousBuildId: null } },
  ])(
    'refuses unknown prior activation without guessing from build timestamps: %j',
    ({ pointer, latest }) => {
      expect(() => previousActivation(pointer, latest)).toThrowError(
        expect.objectContaining({ code: 'LORE_E_BUILD_NOT_FOUND' }),
      );
    },
  );
  it.each([
    { ...transition, buildId: A },
    { ...transition, generation: 5 },
  ])('refuses a history entry that disagrees with the captured pointer: %j', (latest) => {
    expect(() => previousActivation(active, latest)).toThrowError(
      expect.objectContaining({ code: 'LORE_E_SCHEMA_MISMATCH' }),
    );
  });
});
