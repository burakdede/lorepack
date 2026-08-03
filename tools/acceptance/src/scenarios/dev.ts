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
        // SIGTERM rather than SIGINT, deliberately. Windows has no POSIX signals: Node
        // emulates `kill('SIGINT')` from a parent with `TerminateProcess`, so the handler
        // never runs and the supervisor dies with a non-zero code having done nothing
        // wrong. SIGTERM reaches the handler on every platform this ships to, and a clean
        // stop is the thing being asserted. #55 owns the shutdown contract, and #61 owns
        // the general Windows signal question.
        signal: 'SIGTERM',
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
              // And it is watching, which is what makes it `dev` rather than `serve`.
              'Watching for changes',
            ],
          },
        },
      },
    ],
  },
  {
    id: 'dev/an-edit-while-it-runs-becomes-the-next-answer',
    title: '`lore dev` rebuilds when a document changes underneath it',
    proves:
      'Section 12.11: a save is noticed, coalesced, hashed and rebuilt, with no restart and no client action.',
    mode: 'auto',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'interrupt',
        args: ['dev'],
        // SIGTERM rather than SIGINT, deliberately. Windows has no POSIX signals: Node
        // emulates `kill('SIGINT')` from a parent with `TerminateProcess`, so the handler
        // never runs and the supervisor dies with a non-zero code having done nothing
        // wrong. SIGTERM reaches the handler on every platform this ships to, and a clean
        // stop is the thing being asserted. #55 owns the shutdown contract, and #61 owns
        // the general Windows signal question.
        signal: 'SIGTERM',
        afterOutput: 'MCP stdio',
        // Long enough for the write below to land, be debounced, and be rebuilt.
        afterMs: 4000,
        writeWhileRunning: {
          path: 'deployment.md',
          contents: '# Deployment\n\n## Freeze\n\nNo deployments during a change freeze.\n',
        },
        describe: 'Change a document while `lore dev` is running, then stop it',
        expect: {
          exitCode: 0,
          stderr: { contains: ['rebuilding'] },
        },
      },
    ],
  },
];
