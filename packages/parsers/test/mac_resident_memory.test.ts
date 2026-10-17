import { expect, it } from 'vitest';
import { parseMacResidentMemory } from '../src/resident_memory.js';

it.each([
  ['312', 312 * 1024],
  ['  312\n', 312 * 1024],
  ['0\n', 0],
] as const)('reads macOS resident bytes from %j', (report, bytes) => {
  expect(parseMacResidentMemory(report)).toBe(bytes);
});

it.each(['', ' \n', '-', '-1', '12\n13', '12 kB', 'unknown'])(
  'rejects malformed macOS RSS %j',
  (report) => {
    expect(() => parseMacResidentMemory(report)).toThrow(
      `macOS did not report parser resident memory: ${JSON.stringify(report)}.`,
    );
  },
);
