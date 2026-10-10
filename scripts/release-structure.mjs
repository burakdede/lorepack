// Structural release-workflow rules, read from parsed YAML rather than from substrings (#604).
//
// String matching cannot tell which job a permission or a step belongs to, and the rules that
// matter here are all about that: which job can mint the npm OIDC token, what else runs in
// that job, and which job may tag. #618 tracks moving the rest of the release gate to this.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { parse } = createRequire(join(import.meta.dirname, '..', 'packages', 'cli', 'package.json'))(
  'yaml',
);

export const PUBLISH_ENVIRONMENT = 'npm-release';

function needsOf(job) {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function ancestors(jobs, id, seen = new Set()) {
  for (const parent of needsOf(jobs[id] ?? {})) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    ancestors(jobs, parent, seen);
  }
  return seen;
}

function steps(job) {
  return Array.isArray(job.steps) ? job.steps : [];
}

function environmentName(job) {
  return typeof job.environment === 'object' && job.environment !== null
    ? job.environment.name
    : job.environment;
}

function isReadOnly(permissions) {
  if (permissions === undefined || permissions === null) return false;
  if (typeof permissions === 'string') return permissions === 'read-all';
  return Object.values(permissions).every((value) => value === 'read' || value === 'none');
}

/** Problems with a workflow that should grant only read access at its top level. */
export function topLevelPermissionProblems(name, text) {
  const workflow = parse(text);
  return isReadOnly(workflow?.permissions)
    ? []
    : [`${name} must declare a read-only top-level permissions block`];
}

/** Problems with the release workflow's job structure. */
export function releaseStructureProblems(text) {
  const problems = [];
  const workflow = parse(text);
  const jobs = workflow?.jobs ?? {};

  problems.push(...topLevelPermissionProblems('release.yml', text));

  const minting = Object.entries(jobs).filter(
    ([, job]) => job.permissions?.['id-token'] === 'write',
  );
  if (minting.length !== 1) {
    problems.push(
      `release.yml must grant id-token: write to exactly one job, not ${minting.length}`,
    );
  }

  for (const [id, job] of Object.entries(jobs)) {
    const installs = steps(job).some((step) => /\bpnpm\b/.test(String(step.run ?? '')));
    const usesPnpm = steps(job).some((step) => String(step.uses ?? '').startsWith('pnpm/'));
    if (job.permissions?.['id-token'] === 'write' && (installs || usesPnpm)) {
      problems.push(`release.yml job ${id} holds id-token: write and runs pnpm`);
    }
  }

  const [publishId, publish] = minting[0] ?? [];
  if (publish !== undefined) {
    if (environmentName(publish) !== PUBLISH_ENVIRONMENT) {
      problems.push(
        `release.yml job ${publishId} must run in the ${PUBLISH_ENVIRONMENT} environment`,
      );
    }
    if (!steps(publish).some((step) => /scripts\/publish-packages\.mjs/.test(String(step.run)))) {
      problems.push(`release.yml job ${publishId} must publish with scripts/publish-packages.mjs`);
    }
    for (const step of steps(publish)) {
      if (!String(step.uses ?? '').startsWith('actions/checkout')) continue;
      if (
        step.with?.['sparse-checkout'] === undefined ||
        step.with?.['persist-credentials'] !== false
      ) {
        problems.push(
          `release.yml job ${publishId} may only check out a sparse tree without persisted credentials`,
        );
      }
    }
  }

  for (const [id, job] of Object.entries(jobs)) {
    const tags = steps(job).some((step) =>
      /gh release create|git tag|git push[^\n]*refs\/tags/.test(String(step.run ?? '')),
    );
    if (!tags) continue;
    if (publishId === undefined || !ancestors(jobs, id).has(publishId)) {
      problems.push(`release.yml job ${id} tags or releases without needing the publish job`);
    }
  }

  for (const [id, job] of Object.entries(jobs)) {
    for (const step of steps(job)) {
      // An expression inside `run:` is pasted into the shell before it runs, so an input
      // reaches a script only through `env:`, where it is a value rather than code.
      if (/\$\{\{\s*(inputs|github\.event)\./.test(String(step.run ?? ''))) {
        problems.push(`release.yml job ${id} interpolates an input into a run script`);
      }
    }
  }

  const guard = Object.entries(jobs).find(([, job]) =>
    steps(job).some((step) => /refs\/heads\/main/.test(String(step.run ?? ''))),
  )?.[0];
  if (guard === undefined) {
    problems.push('release.yml must restrict a real release to main');
  } else {
    for (const id of Object.keys(jobs)) {
      if (id !== guard && !ancestors(jobs, id).has(guard)) {
        problems.push(`release.yml job ${id} does not depend on the ${guard} job`);
      }
    }
  }

  return problems;
}
