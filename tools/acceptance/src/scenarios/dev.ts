import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * The headline command, run the way the README will tell someone to run it.
 *
 * Architecture 6.2 promises that a bare directory becomes a running, connected runtime with
 * no questions asked. That promise is only meaningful end to end: each half works in
 * isolation already, and what a person experiences is whether the whole sequence completes
 * without them being asked anything or having to read a second page.
 */
export const DEV_SCENARIOS: readonly Scenario[] = [
  {
    id: 'dev/one-command-turns-a-folder-into-a-runtime',
    title: '`lore dev` configures, builds and serves an unconfigured folder',
    proves:
      'Section 6.2 and 6.4: the zero-config path runs in order, writes only what it names, and prints where to connect.',
    mode: 'auto',
    // No `init` in the setup: having to initialize first is exactly what this command exists
    // to remove, so the scenario starts from a folder with documents and nothing else.
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'interrupt',
        args: ['dev'],
        signal: 'SIGINT',
        // Wait for the connection block, which is the last thing printed and therefore
        // proof that every step before it finished.
        afterOutput: 'MCP stdio',
        afterMs: 250,
        describe: 'Point `lore dev` at a folder that has never been built, then stop it',
        expect: {
          exitCode: 0,
          stdout: {
            contains: [
              // It said what it wrote.
              'Created:',
              'lore.yaml',
              // It built and activated.
              'Build ',
              'Reused          0 artifacts (first build)',
              // It said where to reach it.
              'HTTP            http://127.0.0.1:',
              'MCP HTTP        http://127.0.0.1:',
              'MCP stdio       lore mcp --project',
            ],
          },
        },
      },
    ],
  },
];
