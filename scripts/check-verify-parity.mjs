#!/usr/bin/env node
// `pnpm verify` and CI run the same checks, or this fails.
//
// AGENTS.md section 10 says everything runs from one command set. That was not true: the CI
// `verify` job hand-listed its steps, so three checks in the `verify` script were never run by
// CI at all, and three CI steps were never run by `pnpm verify`. Both halves are bad. A
// contributor who runs the documented command gets a weaker signal than CI, and a check added
// to the script quietly does nothing on every pull request.
//
// It cost a broken README on `main` (#214): `check:docs-images` existed, was in `verify`, and
// had never once run in CI. The only thing that caught it was a phase gate, two workflows away,
// because the phase 0 `command-set` criterion runs `pnpm run verify` and CI does not.
//
// Regex over the workflow rather than a YAML parser, deliberately. This has to hold with no
// dependency and no post-install script, and the shape being matched is `run: pnpm <script>`,
// which is not the part of YAML that needs a parser to read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

/**
 * Scripts a job may run without being in `verify`, and why.
 *
 * Each entry is a decision, not an exemption to be added to when something is inconvenient.
 * Anything not listed here must appear in both places.
 */
const OUTSIDE_VERIFY = new Map([
  ['install', 'pnpm itself, not a check'],
  ['exec', 'pnpm itself, not a check'],
  ['build', 'a step other checks depend on, and `verify` reaches it through `test`'],
  [
    'acceptance',
    'its own job, because it is minutes rather than seconds and the question on failure is which scenario',
  ],
  ['test:e2e', 'its own job: it needs a browser, which not every contributor has installed'],
  ['bench', 'reported, never enforced, so it cannot gate anything'],
  ['bench:retrieval', 'reported, never enforced'],
  [
    'check:changeset-policy',
    'pull-request-only gate: commit history is meaningful before merge, not on main',
  ],
]);

/** The `verify` script is one string of `pnpm a && pnpm b`, so every mention is a command. */
const scriptsInVerify = (text) =>
  new Set([...text.matchAll(/pnpm (?:run )?([a-z][a-z0-9:_-]*)/g)].map((match) => match[1]));

/**
 * Only what a workflow actually runs.
 *
 * Anchored to `run:` rather than matching anywhere in the file, because a step's `name:` is
 * prose and may perfectly reasonably mention `pnpm verify`. The first version of this check
 * matched its own step name and reported that CI runs a script called `verify`.
 */
const scriptsInWorkflow = (text) =>
  new Set(
    [...text.matchAll(/^\s*(?:-\s*)?run:\s*pnpm (?:run )?([a-z][a-z0-9:_-]*)/gm)].map(
      (match) => match[1],
    ),
  );

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const verify = scriptsInVerify(packageJson.scripts.verify);
const ci = scriptsInWorkflow(readFileSync(WORKFLOW, 'utf8'));

const missingFromCi = [...verify].filter((script) => !ci.has(script)).sort();
const missingFromVerify = [...ci]
  .filter((script) => !verify.has(script) && !OUTSIDE_VERIFY.has(script))
  .sort();

if (missingFromCi.length > 0 || missingFromVerify.length > 0) {
  console.error('check:verify-parity: `pnpm verify` and CI have drifted');
  for (const script of missingFromCi) {
    console.error(`  ${script} is in \`verify\` and is never run by ci.yml`);
  }
  for (const script of missingFromVerify) {
    console.error(`  ${script} is run by ci.yml and is not in \`verify\``);
  }
  console.error(
    '\nAdd it to both, or record why it belongs in only one in OUTSIDE_VERIFY in this file.',
  );
  process.exit(1);
}

console.log(`check:verify-parity: ${verify.size} checks, run identically by \`verify\` and CI`);
