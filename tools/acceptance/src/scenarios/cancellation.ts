import type { Scenario } from '../types.js';

/**
 * Cancelling work that is actually in flight.
 *
 * Its own area because the guarantee is unusual: what matters is not what the command does
 * but what it does not do. Section 4.3 states it directly, and the promise is not that
 * temporary files are tidy, it is that `builds/` and the active pointer are unchanged.
 *
 * The corpus is generated and large on purpose. Interrupting a build that finishes in
 * 40 milliseconds proves only that the process can be killed.
 */
export const CANCELLATION_SCENARIOS: readonly Scenario[] = [
  {
    id: 'cancellation/interrupt-during-parsing-changes-nothing',
    title: 'Ctrl-C while parsing stops the build and leaves the project exactly as it was',
    proves: 'Section 4.3 and invariant 4: an interrupt stops at the next checkpoint.',
    mode: 'auto',
    regression: 146,
    // Windows has no signal delivery: `child.kill('SIGINT')` terminates the process without
    // giving it the chance to handle anything, so the assertion would be about libuv rather
    // than about Lorepack. The manual scenario covers a person pressing Ctrl-C there.
    skip: {
      platforms: ['win32'],
      reason:
        'Windows has no POSIX signal delivery, so kill() terminates rather than notifies. Covered by manual/ctrl-c-is-honoured-by-a-person.',
    },
    fixture: {
      generated: { documents: 500, sectionsPerDocument: 60 },
      setup: ['init'],
    },
    steps: [
      { action: 'record', name: 'before' },
      {
        action: 'interrupt',
        args: ['build'],
        signal: 'SIGINT',
        // Well past discovery and fingerprinting, and well short of a corpus that takes
        // several seconds to parse, on any machine this suite runs on.
        afterMs: 1500,
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_CANCELLED',
          // The interrupt notice goes to stderr, unlike progress, because it is a
          // diagnostic about the process rather than part of the human result.
          stderr: { contains: ['Interrupted'] },
        },
      },
      {
        action: 'unchanged',
        name: 'before',
        describe: 'No build directory appeared, and the active pointer did not move',
      },
      {
        action: 'run',
        args: ['builds'],
        json: true,
        describe: 'Nothing was activated by a build the user cancelled',
        expect: { exitCode: 0, json: [{ path: 'activeBuildId', equals: null }] },
      },
    ],
  },

  {
    id: 'cancellation/second-interrupt-does-not-resurrect-the-build',
    title: 'Interrupting twice ends the process without leaving a build behind',
    proves: 'Section 4.3: a second interrupt means the user is no longer asking.',
    mode: 'auto',
    regression: 146,
    skip: {
      platforms: ['win32'],
      reason:
        'Windows has no POSIX signal delivery, so kill() terminates rather than notifies. Covered by manual/ctrl-c-is-honoured-by-a-person.',
    },
    fixture: {
      generated: { documents: 500, sectionsPerDocument: 60 },
      setup: ['init'],
    },
    steps: [
      { action: 'record', name: 'before' },
      {
        action: 'interrupt',
        args: ['build'],
        signal: 'SIGINT',
        afterMs: 1500,
        repeat: 2,
        expect: { exitCode: 1 },
      },
      { action: 'unchanged', name: 'before' },
    ],
  },

  {
    id: 'cancellation/interrupt-during-fingerprinting-changes-nothing',
    title: 'An interrupt in the first stage is honoured too, not only in the long one',
    proves: 'Section 4.3: every stage checks, so cancellation does not depend on timing.',
    mode: 'auto',
    regression: 146,
    skip: {
      platforms: ['win32'],
      reason:
        'Windows has no POSIX signal delivery, so kill() terminates rather than notifies. Covered by manual/ctrl-c-is-honoured-by-a-person.',
    },
    fixture: {
      // Wide rather than deep: thousands of tiny files make discovery and fingerprinting
      // the slow part, which is a different stage from the one above.
      generated: { documents: 2400, sectionsPerDocument: 1 },
      setup: ['init'],
    },
    steps: [
      { action: 'record', name: 'before' },
      {
        action: 'interrupt',
        args: ['build'],
        signal: 'SIGINT',
        afterMs: 250,
        expect: { exitCode: 1, errorCode: 'LORE_E_CANCELLED' },
      },
      { action: 'unchanged', name: 'before' },
    ],
  },
];
