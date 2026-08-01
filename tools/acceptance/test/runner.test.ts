import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fill, pluck, runScenario } from '../src/index.js';
import type { Scenario } from '../src/types.js';

/**
 * Tests for the harness, not for the product.
 *
 * A suite is only evidence if its runner is. These drive the runner against a stub binary
 * whose behaviour is known, so a broken assertion here fails loudly instead of turning
 * every acceptance scenario into a silent pass.
 */

const STUB = join(import.meta.dirname, 'fixtures', 'stub-binary.mjs');

const scenario = (steps: Scenario['steps']): Scenario => ({
  id: 'stub/case',
  title: 'A stub scenario',
  proves: 'nothing about the product, everything about the runner',
  mode: 'auto',
  fixture: { files: { 'a.md': '# A\n' } },
  steps,
});

describe('pluck', () => {
  const value = { a: { b: [{ c: 1 }, { c: 2 }] }, top: 'x', nested: [[7]] };

  it.each([
    ['top', 'x'],
    ['a.b[0].c', 1],
    ['a.b[1].c', 2],
    ['nested[0][0]', 7],
  ] as const)('reads %s', (path, expected) => {
    expect(pluck(value, path)).toBe(expected);
  });

  it.each(['missing', 'a.missing.c', 'a.b[9].c', 'top.deeper'])(
    'returns undefined for %s',
    (path) => {
      expect(pluck(value, path)).toBeUndefined();
    },
  );
});

describe('fill', () => {
  it('substitutes captured values', () => {
    expect(fill('build {{id}} now', new Map([['id', 'lore_abc']]))).toBe('build lore_abc now');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(fill('build {{id}}', new Map())).toBe('build {{id}}');
  });
});

describe('the runner', () => {
  it('passes a scenario whose expectations hold', async () => {
    const report = await runScenario(
      scenario([
        {
          action: 'run',
          args: ['ok'],
          expect: { exitCode: 0, stdout: { contains: ['all good'] } },
        },
      ]),
      { binary: STUB },
    );
    expect(report.failures).toEqual([]);
  });

  it('reports the exit code, the stream and the command when an expectation fails', async () => {
    const report = await runScenario(
      scenario([{ action: 'run', args: ['fail', '3'], expect: { exitCode: 0 } }]),
      { binary: STUB },
    );
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('lore fail 3');
    expect(report.failures[0]).toContain('exited 3, expected 0');
  });

  it('checks typed error codes wherever the renderer put them', async () => {
    const report = await runScenario(
      scenario([
        { action: 'run', args: ['fail'], expect: { exitCode: 1, errorCode: 'LORE_E_STUB' } },
      ]),
      { binary: STUB },
    );
    expect(report.failures).toEqual([]);
  });

  it('asserts on JSON paths and captures values for later steps', async () => {
    const report = await runScenario(
      scenario([
        {
          action: 'run',
          args: ['json'],
          json: true,
          capture: { first: 'list[0].name' },
          expect: {
            stdoutIsJson: true,
            json: [
              { path: 'counts.items', equals: 3 },
              { path: 'counts.items', atLeast: 2 },
              { path: 'id', matches: '^stub$' },
              { path: 'missing', exists: false },
            ],
          },
        },
        { action: 'run', args: ['echo', '{{first}}'], expect: { stdout: { contains: ['first'] } } },
      ]),
      { binary: STUB },
    );
    expect(report.failures).toEqual([]);
  });

  it('fails a JSON assertion with the actual value in the message', async () => {
    const report = await runScenario(
      scenario([
        {
          action: 'run',
          args: ['json'],
          json: true,
          expect: { json: [{ path: 'counts.items', equals: 4 }] },
        },
      ]),
      { binary: STUB },
    );
    expect(report.failures[0]).toContain('counts.items is 3, expected 4');
  });

  it('counts repeated output, which is what separates progress from a spinner', async () => {
    const report = await runScenario(
      scenario([
        {
          action: 'run',
          args: ['echo', 'tick tick tick'],
          expect: { stdout: { occurrences: [{ pattern: 'tick', atLeast: 3 }] } },
        },
      ]),
      { binary: STUB },
    );
    expect(report.failures).toEqual([]);
  });

  it('fails when a pattern does not repeat often enough', async () => {
    const report = await runScenario(
      scenario([
        {
          action: 'run',
          args: ['echo', 'tick'],
          expect: { stdout: { occurrences: [{ pattern: 'tick', atLeast: 3 }] } },
        },
      ]),
      { binary: STUB },
    );
    expect(report.failures[0]).toContain('1 time');
  });

  it.skipIf(process.platform === 'win32')('delivers a real signal to a real process', async () => {
    // The reason this test exists: an injected AbortSignal proves the checkpoints honour
    // an aborted signal and proves nothing about the signal arriving, which is how #146
    // survived a suite of 720 tests.
    const report = await runScenario(
      scenario([
        {
          action: 'interrupt',
          args: ['busy'],
          signal: 'SIGINT',
          afterMs: 400,
          expect: { exitCode: 17, stderr: { contains: ['stub interrupted'] } },
        },
      ]),
      { binary: STUB },
    );
    expect(report.failures).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'delivers SIGTERM as well, since a supervisor sends that one',
    async () => {
      const report = await runScenario(
        scenario([
          {
            action: 'interrupt',
            args: ['busy'],
            signal: 'SIGTERM',
            afterMs: 400,
            expect: { exitCode: 18, stderr: { contains: ['stub terminated'] } },
          },
        ]),
        { binary: STUB },
      );
      expect(report.failures).toEqual([]);
    },
  );

  it('runs two commands at once and reports on the second', async () => {
    const report = await runScenario(
      scenario([
        {
          action: 'concurrent',
          background: ['ok'],
          foreground: ['echo', 'second'],
          afterMs: 50,
          expect: { exitCode: 0, stdout: { contains: ['second'] } },
        },
      ]),
      { binary: STUB },
    );
    expect(report.failures).toEqual([]);
  });

  it('refuses to execute a manual step', async () => {
    const report = await runScenario(
      scenario([{ action: 'note', text: 'do a thing', expect: 'a result' }]),
      { binary: STUB },
    );
    expect(report.failures[0]).toContain('cannot be executed');
  });
});
