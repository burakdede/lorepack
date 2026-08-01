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
];
