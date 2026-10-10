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
  {
    id: 'packaging/the-installed-cli-finds-the-projects-wrangler',
    title: "The installed CLI runs the project's own Wrangler",
    proves:
      'Invariant 7 keeps Wrangler out of the published install, so deploy must find the one the user installed, by package name, and never by walking out of its own package.',
    mode: 'auto',
    regression: 580,
    runFrom: 'installed',
    fixture: {
      files: {
        ...CORPUS,
        // A stand-in with the real package name and bin layout. It answers the two commands
        // `target add --dry-run` needs and fails the rest, which reads as "nothing exists yet".
        'node_modules/wrangler/package.json': JSON.stringify({
          name: 'wrangler',
          version: '9.9.9-fixture',
          bin: { wrangler: './bin/wrangler.js' },
        }),
        'node_modules/wrangler/bin/wrangler.js': [
          'const [command] = process.argv.slice(2);',
          "if (command === '--version') console.log('9.9.9-fixture');",
          "else if (command === 'whoami') console.log(JSON.stringify({ email: 'fixture@example.com', accounts: [{ id: 'fixture-account', name: 'Fixture' }] }));",
          'else process.exit(1);',
          '',
        ].join('\n'),
      },
      setup: ['init'],
    },
    steps: [
      {
        action: 'run',
        args: ['target', 'add', 'cloudflare', '--dry-run'],
        describe: 'Plan a Cloudflare target from the staged install, which ships no Wrangler',
        expect: {
          exitCode: 0,
          stdout: { contains: ['Wrangler 9.9.9-fixture', 'dry run, nothing was changed'] },
        },
      },
    ],
  },
];
