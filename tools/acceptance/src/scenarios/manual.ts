import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * What no machine here can run.
 *
 * These live in the catalogue rather than in someone's head, because a scenario left out
 * is not manual, it is invisible. The renderer turns them into the checklist in
 * `docs/testing/acceptance.md`, which is what section 7 of the working agreement asks for.
 *
 * A scenario belongs here only when automation is genuinely impossible or would prove
 * something different, not when it is merely awkward. Two of the three below became
 * automatable the moment the runner could spawn and signal a real process; the ones that
 * remain need a terminal, a person, or a machine this repository does not control.
 */
export const MANUAL_SCENARIOS: readonly Scenario[] = [
  {
    id: 'manual/tty-progress-rewrites-one-line',
    title: 'On a real terminal, progress rewrites a single line and closes it cleanly',
    proves: 'Section 4.3 and the progress renderer contract: TTY and CI render differently.',
    mode: 'manual',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'note',
        text: 'In a real terminal, build a project large enough to take several seconds, for example the generated corpus used by `scale/progress-repeats-so-work-is-not-a-hang`.',
        expect:
          'Each stage occupies one line that updates in place, roughly once a second, and is replaced by a final `done` line. No stray escape sequences, no line left half-written.',
      },
      {
        action: 'note',
        text: 'Repeat with `NO_COLOR=1`, then with the output piped into `cat`. Colour and width are asserted by unit tests against a writer of known width; what a person is checking here is that a real terminal agrees.',
        expect:
          'The status word of each finished stage is green, and colourless under `NO_COLOR=1`. Piped, each update is a separate plain line with no carriage returns and no escapes, safe to read in a CI log.',
      },
      {
        action: 'note',
        text: 'Narrow the terminal to about 40 columns and build again.',
        expect:
          'Each update stays on one row: the counts are dropped and the status word kept. Nothing wraps, and no half-written row is left behind.',
      },
    ],
  },

  {
    id: 'manual/ctrl-c-is-honoured-by-a-person',
    title: 'Ctrl-C typed by a person cancels a build and leaves the project untouched',
    proves: 'Section 4.3: one interrupt stops at the next checkpoint, a second exits now.',
    mode: 'manual',
    regression: 146,
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'note',
        text: 'Start a build that takes at least ten seconds and press Ctrl-C once while the parsing stage is running.',
        expect:
          'It stops within a second or two, prints that it was interrupted, and exits 1. `lore builds` shows no new build and the active pointer is where it was.',
      },
      {
        action: 'note',
        text: 'Repeat, and press Ctrl-C twice in quick succession.',
        expect: 'The second interrupt ends the process immediately, without waiting.',
      },
    ],
  },

  {
    id: 'manual/clean-machine-installs-with-nothing-else',
    title: 'A machine with only Node can install and use Lorepack',
    proves: 'Invariant 7: no Python, Docker, toolchain, native add-on, model or account.',
    mode: 'manual',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'note',
        text: 'On a fresh machine or container with only a supported Node runtime installed, install the package and run `lore init && lore build && lore search "rollback"` against a small directory of documents. The published files alone are now checked on every commit by `packaging/the-published-files-are-enough`, so what is left here is the part a temporary directory cannot claim: a machine with nothing else on it.',
        expect:
          'No compiler is invoked, nothing is downloaded beyond the package itself, no post-install script runs, and no prompt asks for an account or key.',
      },
      {
        action: 'note',
        text: 'Record the platform, the Node version and the date in the pull request that verified it.',
        expect:
          'Section 8 of the working agreement: an integration claim names the version and date it was checked.',
      },
    ],
  },
];
