import { defineConfig } from 'vitest/config';

/**
 * A suite that only `gate.test.ts` runs, on purpose: its tests are skipped, focused-away or
 * failing in every way a security test could stop proving anything, so the gate can be
 * shown to notice each one. The `.fixture.ts` suffix keeps it out of every real run.
 */
export default defineConfig({
  test: {
    name: 'security-gate-fixture',
    include: ['*.fixture.ts'],
  },
});
