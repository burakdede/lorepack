import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AREAS, runScenario, skippedHere } from '../src/index.js';

/**
 * The acceptance suite.
 *
 * Every automated scenario, driven against the built binary as a subprocess. Nothing here
 * imports the CLI: the contract under test is the one a person meets, which is a process,
 * its exit code and its output.
 */

const BINARY = join(import.meta.dirname, '..', '..', '..', 'packages', 'cli', 'dist', 'entry.js');

describe('the binary under test', () => {
  it('is built, which this suite depends on', () => {
    expect(existsSync(BINARY), `${BINARY} is missing. Run \`pnpm build\` first.`).toBe(true);
  });
});

for (const area of AREAS) {
  const automated = area.scenarios.filter((scenario) => scenario.mode === 'auto');
  if (automated.length === 0) continue;

  describe(area.title, () => {
    for (const scenario of automated) {
      it.skipIf(skippedHere(scenario))(`${scenario.id}: ${scenario.title}`, async () => {
        const report = await runScenario(scenario, { binary: BINARY });
        // One assertion carrying every failure, because a scenario that fails three ways
        // should say so once rather than hide two of them behind the first.
        expect(report.failures.join('\n\n'), `${scenario.id} proves: ${scenario.proves}`).toBe('');
      });
    }
  });
}
