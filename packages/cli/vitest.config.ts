import { defineConfig } from 'vitest/config';

/**
 * The CLI suite runs real builds and spawns the real binary, so its tests take seconds
 * rather than milliseconds. Vitest's 5 s default is sized for unit tests and times out here
 * on Windows, where process spawn and filesystem work cost several times what they do on
 * Linux.
 *
 * The timeout is raised rather than the tests made lighter: driving the actual binary is
 * the point of this suite, and a suite that only passes on the fastest platform is not
 * evidence.
 */
export default defineConfig({
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
