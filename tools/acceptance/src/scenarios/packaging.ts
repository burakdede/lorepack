import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * The product as a user receives it.
 *
 * Every other scenario runs the binary out of the working tree, where a file the package
 * never publishes is still on disk and still resolves. #164 was exactly that: the SQL
 * migrations lived at the repository root, no package shipped them, and an installed CLI
 * died during module evaluation on every command. 761 tests and 34 scenarios were green.
 *
 * So this area runs against a staged `node_modules` tree containing only each package's
 * declared `files`, built outside the repository. It is the automatable half of
 * `manual/clean-machine-installs-with-nothing-else`; what is left to the person is the part
 * a temporary directory cannot claim, which is a genuinely clean machine.
 */
export const PACKAGING_SCENARIOS: readonly Scenario[] = [
  {
    id: 'packaging/the-published-files-are-enough',
    title: 'The lifecycle works from the published files alone',
    proves:
      'Invariant 7: zero-surprise first run. An install has to be usable, not just a checkout.',
    mode: 'auto',
    regression: 164,
    runFrom: 'installed',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'run',
        args: ['init'],
        describe: 'Initialise using the staged install, which holds only published files',
        expect: { exitCode: 0, stdout: { contains: ['lore.yaml'] } },
      },
      {
        action: 'run',
        args: ['build'],
        json: true,
        describe: 'Build, which needs the SQL migrations that #164 never shipped',
        expect: { exitCode: 0, json: [{ path: 'counts.artifacts', equals: 3 }] },
      },
      {
        action: 'run',
        args: ['search', 'rollback'],
        json: true,
        describe: 'And answer a query with provenance, which needs the catalog schema',
        expect: {
          exitCode: 0,
          json: [{ path: 'hits[0].locator.relativePath', exists: true }],
        },
      },
    ],
  },
];
