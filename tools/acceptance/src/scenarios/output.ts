import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * The contract every script and every later protocol depends on: with `--json`, stdout
 * carries the structured result and nothing else. Phase 2 needs the same discipline for
 * `lore mcp`, where stdout carries protocol frames (section 14.3), so it is worth proving
 * here rather than discovering there.
 */
export const OUTPUT_SCENARIOS: readonly Scenario[] = [
  {
    id: 'output/json-stdout-carries-only-the-result',
    title: 'With --json, stdout parses on its own and progress goes to stderr',
    proves: 'Section 4.7: `lore plan --json | jq` works, and section 14.3 depends on it.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['status'],
        json: true,
        expect: {
          exitCode: 0,
          stdoutIsJson: true,
          stderr: { contains: ['Fingerprinting'] },
          json: [
            { path: 'formatVersion', equals: 1 },
            { path: 'sourceState', equals: 'clean' },
          ],
        },
      },
      {
        action: 'run',
        args: ['search', 'rollback'],
        json: true,
        expect: { exitCode: 0, stdoutIsJson: true },
      },
      {
        action: 'run',
        args: ['plan'],
        json: true,
        expect: { exitCode: 0, stdoutIsJson: true },
      },
    ],
  },

  {
    id: 'output/a-large-result-survives-a-pipe',
    title: 'A result far larger than a pipe buffer arrives whole',
    proves: 'Section 4.7: `lore <command> --json | jq` is true at every size, not only small ones.',
    mode: 'auto',
    regression: 154,
    fixture: {
      // Above one pipe buffer by a wide margin: this result is around half a megabyte,
      // where the truncation cut it at exactly 65536 bytes.
      generated: { documents: 2501, sectionsPerDocument: 1 },
      setup: ['init', 'build-large'],
    },
    steps: [
      {
        // The runner reads through a pipe, which is the whole point: to a file or a TTY
        // `process.stdout` is synchronous and the defect is invisible.
        action: 'run',
        args: ['inspect', 'sources'],
        json: true,
        expect: {
          exitCode: 0,
          stdoutIsJson: true,
          json: [
            { path: 'artifacts[2500].displayPath', exists: true },
            { path: 'artifacts[0].displayPath', exists: true },
          ],
        },
      },
    ],
  },

  {
    id: 'output/errors-are-typed-and-machine-readable',
    title: 'A failure carries a code and a remediation in both renderings',
    proves: 'Section 4.4 and the exit-code table: CI can tell the kind of failure apart.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['search', 'anything', '--limit', '0'],
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_INVALID_ARGUMENT',
          stderr: { contains: ['--limit must be between 1 and 100'] },
        },
      },
      {
        action: 'run',
        args: ['activate', 'lore_definitelynotabuild'],
        json: true,
        expect: {
          exitCode: 1,
          stdoutIsJson: true,
          json: [
            { path: 'error.code', equals: 'LORE_E_BUILD_NOT_FOUND' },
            { path: 'error.remediation', exists: true },
          ],
        },
      },
    ],
  },

  {
    id: 'output/every-command-is-registered',
    title: '`lore --help` lists every command this phase ships',
    proves: 'Section 4.8: the command set is explicit, so a lost command is visible.',
    mode: 'auto',
    fixture: { files: {}, setup: [] },
    steps: [
      {
        action: 'run',
        args: ['--help'],
        expect: {
          exitCode: 0,
          stdout: {
            contains: [
              'init',
              'plan',
              'build',
              'status',
              'diff',
              'search',
              'inspect',
              'pack',
              'builds',
              'activate',
              'rollback',
              'prune',
            ],
          },
        },
      },
    ],
  },

  {
    id: 'output/a-failure-names-something-that-exists',
    title: 'Every failure names a real cause and a next step the binary can perform',
    proves: 'Section 4.4: an error names the subject and the way forward.',
    mode: 'auto',
    regression: 168,
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['activate', 'lore_definitelynotabuild'],
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_BUILD_NOT_FOUND',
          stderr: { excludes: ['lore doctor'] },
        },
      },
      {
        action: 'run',
        args: ['inspect', 'nothing-like-this'],
        describe:
          'And a subject that does not exist, which used to fall through to the default advice',
        expect: { exitCode: 1, stderr: { excludes: ['lore doctor'] } },
      },
    ],
  },
];
