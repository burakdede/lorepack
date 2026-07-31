import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHASE_0 } from '../src/phases/phase-0.js';
import { PHASES, phaseDefinition } from '../src/registry.js';
import { checkCriterion, checkPhase, formatReport, type RunOptions } from '../src/run.js';
import { type Criterion, EXIT } from '../src/types.js';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." with a leading
// slash, which is not a valid path. Caught by the Windows CI job.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return { repoRoot: REPO_ROOT, ...overrides };
}

const ok = async () => ({ code: 0, stdout: '', stderr: '' });
const fail = async () => ({ code: 1, stdout: '', stderr: 'boom' });

describe('command criterion', () => {
  const criterion: Criterion = {
    id: 'c',
    kind: 'command',
    promise: 'A command succeeds.',
    command: 'pnpm',
    args: ['lint'],
  };

  it('passes on exit zero and records what it ran', async () => {
    const result = await checkCriterion(criterion, options({ execute: ok }));
    expect(result.outcome).toBe('passed');
    expect(result.evidence).toContain('pnpm lint');
  });

  it('fails on a non-zero exit and keeps the tail of the output', async () => {
    const result = await checkCriterion(criterion, options({ execute: fail }));
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('boom');
  });
});

describe('exports criterion', () => {
  const criterion: Criterion = {
    id: 'e',
    kind: 'exports',
    promise: 'Symbols are exported.',
    module: 'packages/core/dist/index.js',
    symbols: ['LoreError', 'deriveBuildId'],
  };

  it('passes when every symbol is present', async () => {
    const result = await checkCriterion(
      criterion,
      options({ importModule: async () => ({ LoreError: class {}, deriveBuildId: () => '' }) }),
    );
    expect(result.outcome).toBe('passed');
  });

  it('names the missing symbols, which is the hole this closes', async () => {
    const result = await checkCriterion(
      criterion,
      options({ importModule: async () => ({ LoreError: class {} }) }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('deriveBuildId');
  });

  it('fails rather than throwing when the module cannot be imported', async () => {
    const result = await checkCriterion(
      criterion,
      options({
        importModule: async () => {
          throw new Error('not built');
        },
      }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('not built');
  });

  it('fails when a dist path does not exist, pointing at the build', async () => {
    const result = await checkCriterion(
      { ...criterion, module: 'packages/core/dist/does-not-exist.js' } as Criterion,
      options(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('pnpm build');
  });
});

describe('path criterion', () => {
  it('passes for paths that exist and names the ones that do not', async () => {
    const present = await checkCriterion(
      { id: 'p', kind: 'path', promise: 'Docs exist.', paths: ['README.md', 'AGENTS.md'] },
      options(),
    );
    expect(present.outcome).toBe('passed');

    const absent = await checkCriterion(
      { id: 'p', kind: 'path', promise: 'Docs exist.', paths: ['README.md', 'docs/nope.md'] },
      options(),
    );
    expect(absent.outcome).toBe('failed');
    expect(absent.detail).toContain('docs/nope.md');
  });
});

describe('issues criterion', () => {
  const criterion: Criterion = {
    id: 'i',
    kind: 'issues',
    promise: 'Every issue is closed.',
    milestone: 'P0 Foundations',
  };

  it('passes when nothing unexpected is open', async () => {
    const result = await checkCriterion(
      criterion,
      options({ execute: async () => ({ code: 0, stdout: '[]', stderr: '' }) }),
    );
    expect(result.outcome).toBe('passed');
  });

  it('fails listing what is still open', async () => {
    const result = await checkCriterion(
      criterion,
      options({
        execute: async () => ({
          code: 0,
          stdout: JSON.stringify([{ number: 42, title: 'Unfinished' }]),
          stderr: '',
        }),
      }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('#42 Unfinished');
  });

  it('tolerates issues explicitly allowed to remain open', async () => {
    const result = await checkCriterion(
      { ...criterion, allowOpen: [42] } as Criterion,
      options({
        execute: async () => ({
          code: 0,
          stdout: JSON.stringify([{ number: 42, title: 'Epic' }]),
          stderr: '',
        }),
      }),
    );
    expect(result.outcome).toBe('passed');
  });

  it('reports unverified, never passed, when gh is unavailable', async () => {
    const result = await checkCriterion(
      criterion,
      options({
        execute: async () => ({ code: 127, stdout: '', stderr: 'gh: command not found' }),
      }),
    );
    expect(result.outcome).toBe('unverified');
    expect(result.outcome).not.toBe('passed');
    expect(result.detail).toContain('could not be checked');
  });

  it('reports unverified when gh returns something that is not JSON', async () => {
    const result = await checkCriterion(
      criterion,
      options({ execute: async () => ({ code: 0, stdout: 'not json', stderr: '' }) }),
    );
    expect(result.outcome).toBe('unverified');
  });
});

describe('audit criterion', () => {
  const criterion: Criterion = {
    id: 'a',
    kind: 'audit',
    promise: 'The next phase was audited.',
    nextEpic: 2,
  };

  const epicBody = (body: string) => async () => ({ code: 0, stdout: body, stderr: '' });

  it('passes when the next epic carries a dated audit', async () => {
    const result = await checkCriterion(
      criterion,
      options({ execute: epicBody('## Phase 1 audit, 2026-07-31, using what Phase 0 taught us') }),
    );
    expect(result.outcome).toBe('passed');
  });

  it('fails when the next epic has no audit, and says what to do', async () => {
    const result = await checkCriterion(
      criterion,
      options({ execute: epicBody('# Epic. Theme: something. Exit criteria: things.') }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('carries no audit');
    expect(result.detail).toContain('AGENTS.md');
  });

  it('fails an undated audit, since a reader cannot tell which phase it followed', async () => {
    const result = await checkCriterion(
      criterion,
      options({ execute: epicBody('## Audit of the next phase') }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('no date');
  });

  it('reports unverified, never passed, when gh is unavailable', async () => {
    const result = await checkCriterion(
      criterion,
      options({ execute: async () => ({ code: 127, stdout: '', stderr: 'gh: not found' }) }),
    );
    expect(result.outcome).toBe('unverified');
    expect(result.outcome).not.toBe('passed');
  });

  it('passes for a final phase with no successor, without calling gh', async () => {
    let called = false;
    const result = await checkCriterion(
      { ...criterion, nextEpic: null } as Criterion,
      options({
        execute: async () => {
          called = true;
          return { code: 1, stdout: '', stderr: '' };
        },
      }),
    );
    expect(result.outcome).toBe('passed');
    expect(called).toBe(false);
    expect(result.evidence).toContain('no successor');
  });
});

describe('phase outcome', () => {
  const base = { phase: 9, title: 'Test', epic: 999 };

  it('is failed when anything failed, even alongside unverified', async () => {
    const report = await checkPhase(
      {
        ...base,
        criteria: [
          { id: 'a', kind: 'command', promise: 'p', command: 'x', args: [] },
          { id: 'b', kind: 'issues', promise: 'p', milestone: 'M' },
        ],
      },
      options({ execute: fail }),
    );
    expect(report.outcome).toBe('failed');
    expect(EXIT[report.outcome]).toBe(1);
  });

  it('is unverified when nothing failed but something could not be checked', async () => {
    const report = await checkPhase(
      { ...base, criteria: [{ id: 'b', kind: 'issues', promise: 'p', milestone: 'M' }] },
      options({ execute: async () => ({ code: 127, stdout: '', stderr: 'missing' }) }),
    );
    expect(report.outcome).toBe('unverified');
    expect(EXIT[report.outcome]).toBe(2);
  });

  it('is passed only when every criterion passed', async () => {
    const report = await checkPhase(
      { ...base, criteria: [{ id: 'a', kind: 'command', promise: 'p', command: 'x', args: [] }] },
      options({ execute: ok }),
    );
    expect(report.outcome).toBe('passed');
    expect(EXIT[report.outcome]).toBe(0);
  });
});

describe('report', () => {
  it('shows the promise and the evidence for every criterion', async () => {
    const report = await checkPhase(
      {
        phase: 9,
        title: 'Test',
        epic: 999,
        criteria: [
          { id: 'a', kind: 'command', promise: 'Something is guaranteed.', command: 'x', args: [] },
        ],
      },
      options({ execute: ok }),
    );
    const text = formatReport(report);
    expect(text).toContain('Something is guaranteed.');
    expect(text).toContain('checked: ran `x`');
    expect(text).toContain('1 passed, 0 failed, 0 unverified');
  });

  it('says plainly that an unverified criterion is not a pass', async () => {
    const report = await checkPhase(
      {
        phase: 9,
        title: 'Test',
        epic: 999,
        criteria: [{ id: 'b', kind: 'issues', promise: 'p', milestone: 'M' }],
      },
      options({ execute: async () => ({ code: 1, stdout: '', stderr: 'no gh' }) }),
    );
    expect(formatReport(report)).toContain('not a pass');
  });
});

describe('phase 0 definition', () => {
  it('is registered and retrievable by number', () => {
    expect(phaseDefinition(0)).toBe(PHASE_0);
    expect(phaseDefinition(7)).toBeNull();
    expect(PHASES).toContain(PHASE_0);
  });

  it('covers every promise in the epic: exit criteria, deliverable, and capabilities', () => {
    const ids = PHASE_0.criteria.map((criterion) => criterion.id);
    for (const required of [
      'issues-closed',
      'determinism',
      'dependency-direction',
      'exit-criterion-harness',
      'workspace-layout',
      'engine-guard',
      'command-set',
      'public-schemas',
      'canonical-primitives',
      'storage-ports',
      'sqlite-adapter',
      'fts5-available',
      'object-store',
      'active-pointer',
      'error-taxonomy',
      'progress-reporting',
      'install-guarantees',
      'forward-audit',
      'documentation',
    ]) {
      expect(ids, `missing criterion: ${required}`).toContain(required);
    }
  });

  it('gives every criterion a unique id and a promise written as a guarantee', () => {
    const ids = PHASE_0.criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const criterion of PHASE_0.criteria) {
      expect(criterion.promise.length, criterion.id).toBeGreaterThan(20);
      expect(criterion.promise.endsWith('.'), criterion.id).toBe(true);
    }
  });
});
