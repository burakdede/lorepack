import type { Scenario } from '../types.js';

/**
 * The scenarios that only mean something when there is enough work to watch.
 *
 * Corpus sizes are chosen so parsing lasts several seconds on a fast machine: a stage that
 * finishes in under a second cannot demonstrate that progress repeats, and a build that
 * finishes instantly cannot demonstrate that a second command waits.
 */
export const SCALE_SCENARIOS: readonly Scenario[] = [
  {
    id: 'scale/envelope-guard-refuses-then-yields',
    title: 'A project above the supported file count is refused, with a flag that continues',
    proves: 'Section 5.4: beyond the envelope performance is untested, not forbidden.',
    mode: 'auto',
    fixture: {
      generated: { documents: 2501, sectionsPerDocument: 1 },
      setup: ['init'],
    },
    steps: [
      {
        action: 'run',
        args: ['build'],
        expect: {
          // Exit 1, not 2: an oversized project is a user or configuration problem, not a
          // build integrity failure. The exit-code table is what CI reads.
          exitCode: 1,
          errorCode: 'LORE_E_ENVELOPE_EXCEEDED',
          stderr: { contains: ['--allow-large-project', 'untested rather than unsupported'] },
        },
      },
      {
        action: 'run',
        args: ['build', '--allow-large-project'],
        json: true,
        expect: { exitCode: 0, json: [{ path: 'counts.artifacts', equals: 2501 }] },
      },
    ],
  },

  {
    id: 'scale/a-build-that-exists-can-always-be-queried',
    title: 'Every read-only command works on a project above the envelope',
    proves: 'Invariant 1: a runtime is a projection of a build, not of the source tree.',
    mode: 'auto',
    regression: 147,
    fixture: {
      generated: { documents: 2501, sectionsPerDocument: 1 },
      setup: ['init', 'build-large'],
    },
    steps: [
      {
        // The defect: `search` established freshness by walking the sources, so a guard
        // about the cost of building refused to answer from a build already made.
        action: 'run',
        args: ['search', 'rollback'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'hits[0].locator.relativePath', exists: true },
            { path: 'sourceState', equals: 'clean' },
          ],
        },
      },
      {
        // Human rendering rather than `--json`, because a result this large is truncated
        // on a pipe today (#154). That is a separate defect with its own scenario; asserting
        // it here would make this one fail for a reason that has nothing to do with #147.
        action: 'run',
        args: ['inspect', 'sources'],
        expect: { exitCode: 0, stdout: { contains: ['2501 artifacts'] } },
      },
      { action: 'run', args: ['builds'], json: true, expect: { exitCode: 0 } },
      { action: 'run', args: ['pack'], json: true, expect: { exitCode: 0 } },
      {
        action: 'run',
        args: ['diff'],
        describe: 'And a diff against the only build reports no second build to compare',
        expect: { exitCode: 1, errorCode: 'LORE_E_BUILD_NOT_FOUND' },
      },
    ],
  },

  {
    id: 'scale/progress-repeats-so-work-is-not-a-hang',
    title: 'A long build reports measurable progress more than once',
    proves: 'Section 4.3: no command appears to hang. Section 5.5 makes it a release gate.',
    mode: 'auto',
    fixture: {
      generated: { documents: 500, sectionsPerDocument: 60 },
      setup: ['init'],
    },
    steps: [
      {
        action: 'run',
        args: ['build'],
        expect: {
          exitCode: 0,
          // Progress goes to stdout unless `--json` moves it to stderr, which is the
          // contract `output/json-stdout-carries-only-the-result` pins down.
          stdout: {
            // A spinner would satisfy "something is happening" and prove nothing. The
            // assertion is on counts that advance, which is what tells slow from stuck.
            occurrences: [{ pattern: 'Parsing\\s+[\\d,]+/500', atLeast: 3 }],
            contains: ['Indexing', 'Sealing', 'Activating'],
          },
        },
      },
    ],
  },

  {
    id: 'scale/second-command-waits-for-the-lock',
    title: 'A command that has to wait for the project lock says so instead of sitting silent',
    proves: 'Section 4.3 and invariant 4: concurrent runs serialise, visibly.',
    mode: 'auto',
    fixture: {
      generated: { documents: 500, sectionsPerDocument: 60 },
      setup: ['init'],
    },
    steps: [
      {
        action: 'concurrent',
        background: ['build'],
        foreground: ['build'],
        afterMs: 1200,
        describe: 'Start a build, then start a second one while the first is still parsing',
        expect: {
          exitCode: 0,
          stdout: { contains: ['Waiting for the project lock', 'No changes'] },
        },
      },
    ],
  },
];
