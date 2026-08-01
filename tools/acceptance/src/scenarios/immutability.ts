import type { Scenario } from '../types.js';
import { CORPUS, EDITED_ONBOARDING } from './corpus.js';

/**
 * Invariant 4: a failed build or deploy can never corrupt the active version. Every
 * scenario here is a way of trying to break that, plus the archive, which is the same
 * promise made portable.
 */
export const IMMUTABILITY_SCENARIOS: readonly Scenario[] = [
  {
    id: 'immutability/no-activate-leaves-the-pointer',
    title: '`lore build --no-activate` verifies a candidate without moving the pointer',
    proves: 'Invariant 4: activation is a separate, deliberate step.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'run', args: ['builds'], json: true, capture: { active: 'activeBuildId' } },
      { action: 'write', path: 'guides/onboarding.md', contents: EDITED_ONBOARDING, atomic: true },
      {
        action: 'run',
        args: ['build', '--no-activate'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'created', equals: true },
            { path: 'activated', equals: false },
            { path: 'buildId', differsFromCapture: 'active' },
          ],
        },
      },
      {
        action: 'run',
        args: ['builds'],
        json: true,
        expect: { exitCode: 0, json: [{ path: 'activeBuildId', equalsCapture: 'active' }] },
      },
    ],
  },

  {
    id: 'immutability/frozen-lockfile-refuses-drift',
    title: '`lore build --frozen` fails when the lockfile would change, and says how',
    proves: 'Section 18.4: a pinned build is reproducible or it is an error.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        // Written whole rather than patched, because the runner deliberately cannot read
        // files: a scenario asserts behaviour, it does not compute expectations.
        action: 'write',
        path: 'lore.lock',
        contents:
          'formatVersion: 1\ncompiler: 0.9.9\nschema: 1\nparsers:\n  markdown: 0.1.0\n  text: 0.1.0\nsemantic: null\n',
        describe: 'Pin the lockfile to a compiler version that is not the one installed',
      },
      { action: 'record', name: 'before-frozen' },
      {
        action: 'run',
        args: ['build', '--frozen'],
        expect: {
          exitCode: 2,
          errorCode: 'LORE_E_LOCKFILE_DRIFT',
          stderr: { contains: ['compiler: 0.9.9 -> ', 'lore.lock'] },
        },
      },
      { action: 'unchanged', name: 'before-frozen' },
    ],
  },

  {
    id: 'immutability/symlink-escape-is-refused',
    title: 'A symlink pointing outside the project is skipped, and its contents stay out',
    proves: 'Section 19.1: discovery never leaves the project root.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init'] },
    steps: [
      {
        action: 'symlink',
        path: 'guides/escape',
        outsideFile: {
          name: 'confidential.md',
          contents: '# Outside\n\nThe phrase zarquon must never be indexed.\n',
        },
      },
      {
        action: 'run',
        args: ['plan'],
        describe: 'Plan the build, which lists what discovery decided to skip',
        expect: {
          exitCode: 0,
          stdout: { contains: ['symbolic link', 'was skipped'] },
        },
      },
      { action: 'run', args: ['build'], expect: { exitCode: 0 } },
      {
        action: 'run',
        args: ['inspect', 'warnings'],
        json: true,
        describe: 'The build records the skip rather than swallowing it',
        expect: { exitCode: 0, json: [{ path: 'total', atLeast: 1 }] },
      },
      {
        action: 'run',
        args: ['search', 'zarquon'],
        expect: { exitCode: 0, stdout: { contains: ['No matches'], excludes: ['confidential'] } },
      },
    ],
  },

  {
    id: 'immutability/archive-is-a-verifiable-zip',
    title: 'A packed build is a plain ZIP, verifies clean, and fails after one flipped byte',
    proves: 'Section 12.8: the archive is standard and self-checking.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['pack'],
        json: true,
        capture: { archive: 'archive' },
        expect: { exitCode: 0, json: [{ path: 'members', atLeast: 4 }] },
      },
      {
        action: 'external',
        command: 'unzip',
        args: ['-l', '{{archive}}'],
        whenMissing: 'skip',
        describe: 'Open the archive with a stock unzip, where the platform has one',
        expect: {
          exitCode: 0,
          stdout: { contains: ['manifest.json', 'checksums.json', 'context.sqlite'] },
        },
      },
      {
        action: 'run',
        args: ['pack', '--verify', '{{archive}}'],
        expect: { exitCode: 0, stdout: { contains: ['is intact'] } },
      },
      {
        action: 'corrupt',
        path: '{{archive}}',
        offset: 1200,
        describe: 'Flip every bit of one byte inside the archive',
      },
      {
        action: 'run',
        args: ['pack', '--verify', '{{archive}}'],
        expect: {
          exitCode: 2,
          errorCode: 'LORE_E_OBJECT_CORRUPT',
          stderr: { contains: ['cannot be trusted'] },
        },
      },
    ],
  },

  {
    id: 'immutability/packing-does-not-disturb-the-project',
    title: 'An archive written into the project is not then discovered as a source',
    proves: 'Invariant 3: the tool running does not change what the next build sees.',
    mode: 'auto',
    regression: 148,
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'run', args: ['builds'], json: true, capture: { before: 'activeBuildId' } },
      { action: 'run', args: ['pack'], expect: { exitCode: 0 } },
      { action: 'run', args: ['pack', '--out', 'second.lorepack'], expect: { exitCode: 0 } },
      {
        action: 'run',
        args: ['status'],
        json: true,
        describe: 'The sources are still clean, so packing did not dirty the project',
        expect: { exitCode: 0, json: [{ path: 'sourceState', equals: 'clean' }] },
      },
      {
        action: 'run',
        args: ['plan'],
        describe: 'And nothing warns about the archives the tool just wrote',
        expect: { exitCode: 0, stdout: { excludes: ['.lorepack'] } },
      },
      {
        action: 'run',
        args: ['build'],
        json: true,
        describe: 'A rebuild produces the same build, so identity did not move either',
        expect: {
          exitCode: 0,
          json: [
            { path: 'buildId', equalsCapture: 'before' },
            { path: 'created', equals: false },
          ],
        },
      },
    ],
  },

  {
    id: 'immutability/prune-never-deletes-by-default',
    title: '`lore prune` prints its plan and removes nothing without --yes',
    proves: 'Section 4.6: destructive work is opt-in, and never touches the active build.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'write', path: 'guides/onboarding.md', contents: EDITED_ONBOARDING, atomic: true },
      { action: 'run', args: ['build'], json: true, capture: { active: 'buildId' } },
      { action: 'record', name: 'before-prune' },
      {
        action: 'run',
        args: ['prune', '--keep', '0'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'applied', equals: false },
            { path: 'remove[0]', exists: true },
            { path: 'keep[0]', equalsCapture: 'active' },
          ],
        },
      },
      { action: 'unchanged', name: 'before-prune' },
      {
        action: 'run',
        args: ['prune', '--keep', '0', '--yes'],
        json: true,
        expect: { exitCode: 0, json: [{ path: 'applied', equals: true }] },
      },
      {
        action: 'run',
        args: ['builds'],
        json: true,
        describe: 'The active build survived the prune',
        expect: { exitCode: 0, json: [{ path: 'activeBuildId', equalsCapture: 'active' }] },
      },
      {
        action: 'run',
        args: ['search', 'rollback'],
        json: true,
        describe: 'And it still answers, so pruning removed data nothing referenced',
        expect: { exitCode: 0, json: [{ path: 'hits[0].locator.relativePath', exists: true }] },
      },
    ],
  },
];
