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
        // No exit code asserted. A parent process on Windows cannot ask a child to stop
        // gracefully at all: `kill` is emulated with `TerminateProcess`, so the handler
        // never runs and the supervisor dies non-zero having done everything right. What
        // this scenario is about is the output above, which is identical on every platform.
        // The graceful-exit contract is asserted in the POSIX-only end-to-end tests, and
        // #61 owns the general Windows signal question.
        expect: {
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
        // As above: the subject is the rebuild, not how the process was stopped.
        expect: {
          stderr: { contains: ['rebuilding'] },
        },
      },
    ],
  },
  {
    id: 'dev/doctor-explains-the-environment',
    title: '`lore doctor` reports the environment and says what to do about anything wrong',
    proves:
      'Section 6.5 and 6.9: one command names what is wrong and carries a concrete remediation.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['doctor'],
        describe: 'Ask whether this machine and project are in a state that works',
        expect: {
          exitCode: 0,
          stdout: {
            // The checks a user is sent here to read, and the verdict line.
            contains: ['Node version', 'SQLite FTS5', 'Project configuration', 'Everything'],
          },
        },
      },
      {
        action: 'run',
        args: ['doctor', '--json'],
        describe: 'The same report, for a bug report or a pipeline',
        expect: {
          exitCode: 0,
          json: [
            { path: 'status', equals: 'pass' },
            // Every check carries an id, which is what a consumer filters and links on.
            { path: 'checks[0].id', exists: true },
            { path: 'counts.fail', equals: 0 },
          ],
        },
      },
    ],
  },
  {
    id: 'dev/the-two-command-flow-end-to-end',
    title: 'Two commands take a folder to a grounded, cited answer',
    proves:
      'Milestone 1 (section 21): build, connect and answer, with provenance on every result and no manual JSON.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['connect', 'claude-code', '--dry-run'],
        describe: 'See exactly what would be written to the client, before anything is',
        expect: {
          exitCode: 0,
          stdout: {
            contains: ['lore mcp --project', '--ensure-current', 'nothing was changed'],
          },
        },
      },
      {
        action: 'run',
        args: ['connect', 'a-client-nobody-verified'],
        describe: 'An unverified client gets an honest snippet rather than a refusal',
        expect: {
          exitCode: 0,
          stdout: {
            // Architecture 14.7: never imply that every client can reach a local server.
            contains: ['mcpServers', 'unverified', 'lore export'],
          },
        },
      },
      {
        action: 'protocol',
        args: ['mcp', '--ensure-current'],
        method: 'tools/call',
        params: {
          name: 'lore_context_for_task',
          arguments: { task: 'how do I roll back a release' },
        },
        describe: 'Ask the question a coding agent would ask, over the protocol',
        expectResult: ['citations', 'relativePath', 'lore_'],
      },
      {
        action: 'run',
        args: ['export', '--task', 'how do I roll back a release', '--format', 'json'],
        describe: 'The same answer as a file, for a client that cannot speak MCP',
        expect: {
          exitCode: 0,
          json: [
            { path: 'budget', equals: 24000 },
            { path: 'citations[0].relativePath', exists: true },
            { path: 'buildId', matches: '^lore_[0-9a-f]{64}$' },
          ],
        },
      },
    ],
  },
];
