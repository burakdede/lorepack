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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { parse } = createRequire(join(import.meta.dirname, '..', 'packages/cli/package.json'))(
  'yaml',
);

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
  ['build', 'a step other checks depend on, and `verify` reaches it through `test:ci`'],
  [
    'acceptance',
    'its own job, because it is minutes rather than seconds and the question on failure is which scenario',
  ],
  ['test:e2e', 'its own job: it needs a browser, which not every contributor has installed'],
  ['bench', 'reported, never enforced, so it cannot gate anything'],
  ['bench:retrieval', 'reported, never enforced'],
  ['bench:quality', 'quality baseline is enforced by its own benchmark command'],
  [
    'check:packed-cli',
    'its own job: it installs the packed CLI into a clean directory and exercises the actual npm package',
  ],
  [
    'check:changeset-policy',
    'pull-request-only gate: commit history is meaningful before merge, not on main',
  ],
]);

const SINGLE_RUN = new Map([
  [
    'check:supply-chain',
    {
      job: 'supply-chain',
      runsOn: 'ubuntu-latest',
      reason: 'registry-backed audit repeats the same lockfile evidence on every OS',
    },
  ],
]);

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const commands = packageJson.scripts.verify.split('&&').map((command) => command.trim());
const commandPattern = /^pnpm (?:run )?([a-z][a-z0-9:_-]*)$/;
const malformed = commands.filter((command) => !commandPattern.test(command));
const verify = new Set(commands.flatMap((command) => command.match(commandPattern)?.[1] ?? []));
const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
const ci = new Set();
const unsafe = new Set();
const occurrences = new Map();
for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    if (typeof step.run !== 'string') continue;
    const run = step.run.trim();
    const mentions = [...run.matchAll(/(?:^|\n)\s*pnpm (?:run )?([a-z][a-z0-9:_-]*)/g)];
    for (const [, script] of mentions) {
      ci.add(script);
      const entries = occurrences.get(script) ?? [];
      entries.push({ jobName, job, step, run });
      occurrences.set(script, entries);
      if (!verify.has(script)) continue;
      if (
        run.match(commandPattern)?.[1] !== script ||
        step.if !== undefined ||
        job.if !== undefined ||
        step['continue-on-error'] !== undefined ||
        job['continue-on-error'] !== undefined
      )
        unsafe.add(script);
    }
  }
}

const misplacedSingleRun = [];
for (const [script, expected] of SINGLE_RUN) {
  const entries = occurrences.get(script) ?? [];
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry?.jobName !== expected.job ||
    entry?.job?.['runs-on'] !== expected.runsOn ||
    entry?.job?.strategy?.matrix !== undefined ||
    entry?.job?.if !== undefined ||
    entry?.job?.['continue-on-error'] !== undefined ||
    entry?.step?.if !== undefined ||
    entry?.step?.['continue-on-error'] !== undefined ||
    entry?.run.trim() !== `pnpm ${script}`
  )
    misplacedSingleRun.push(
      `${script} must run exactly once, unconditionally, in ${expected.job} on ${expected.runsOn} (${expected.reason})`,
    );
}

const missingFromCi = [...verify].filter((script) => !ci.has(script)).sort();
const missingFromVerify = [...ci]
  .filter((script) => !verify.has(script) && !OUTSIDE_VERIFY.has(script))
  .sort();

if (
  missingFromCi.length > 0 ||
  missingFromVerify.length > 0 ||
  unsafe.size > 0 ||
  malformed.length > 0 ||
  misplacedSingleRun.length > 0
) {
  console.error('check:verify-parity: `pnpm verify` and CI have drifted');
  for (const command of malformed)
    console.error(`  verify must use exact pnpm commands joined by &&: ${command}`);
  for (const script of unsafe)
    console.error(`  ${script} must run as an exact unconditional, non-optional CI command`);
  for (const problem of misplacedSingleRun) console.error(`  ${problem}`);
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
