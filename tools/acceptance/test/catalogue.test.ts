import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AREAS, renderCatalogue, SCENARIOS } from '../src/index.js';
import type { Step } from '../src/types.js';

/**
 * Rules the catalogue has to keep, so that "add a row" stays a safe way to extend it.
 *
 * The expensive failure this prevents is a scenario that looks present and asserts nothing:
 * a manual note hidden in an automated list, an empty step list, an id that collides with
 * another and silently replaces it in a report.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DOC = join(REPO_ROOT, 'docs', 'testing', 'acceptance.md');

/** The command set Phase 1 ships, taken from the scenario that asserts `lore --help`. */
const PHASE_1_COMMANDS = [
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
  'mcp',
];

function commandsUsedBy(step: Step): string[] {
  switch (step.action) {
    case 'run':
    case 'run-in':
    case 'interrupt':
    case 'protocol':
      return step.args[0] === undefined ? [] : [step.args[0]];
    case 'concurrent':
      return [step.background[0], step.foreground[0]].filter(
        (arg): arg is string => arg !== undefined,
      );
    default:
      return [];
  }
}

describe('the catalogue', () => {
  it('gives every scenario a unique id', () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('names every scenario `area/behaviour`, matching the area it sits in', () => {
    for (const area of AREAS) {
      for (const scenario of area.scenarios) {
        expect(scenario.id, scenario.title).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
        expect(scenario.id.split('/')[0], scenario.id).toBe(area.id);
      }
    }
  });

  it('says what each scenario proves, in more than a word', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.proves.length, scenario.id).toBeGreaterThan(20);
      expect(scenario.title.length, scenario.id).toBeGreaterThan(10);
    }
  });

  it('gives every scenario something to do', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.steps.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it('keeps notes out of automated scenarios and actions out of manual ones', () => {
    for (const scenario of SCENARIOS) {
      const notes = scenario.steps.filter((step) => step.action === 'note').length;
      if (scenario.mode === 'auto') expect(notes, scenario.id).toBe(0);
      else expect(notes, scenario.id).toBe(scenario.steps.length);
    }
  });

  it('requires a written reason for every platform skip', () => {
    for (const scenario of SCENARIOS) {
      if (scenario.skip === undefined) continue;
      expect(scenario.skip.reason.length, scenario.id).toBeGreaterThan(20);
      expect(scenario.skip.platforms.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it('exercises every command the phase ships', () => {
    const used = new Set(SCENARIOS.flatMap((scenario) => scenario.steps.flatMap(commandsUsedBy)));
    for (const command of PHASE_1_COMMANDS) {
      expect(used.has(command), `no scenario runs \`lore ${command}\``).toBe(true);
    }
  });

  it('asserts something in every automated scenario', () => {
    for (const scenario of SCENARIOS) {
      if (scenario.mode !== 'auto') continue;
      const asserts = scenario.steps.some(
        (step) =>
          ('expect' in step && step.expect !== undefined) ||
          step.action === 'unchanged' ||
          // A protocol step states its expectations as response and stderr substrings,
          // because there is no exit code or stdout rendering to assert on.
          (step.action === 'protocol' &&
            ((step.expectResult?.length ?? 0) > 0 || (step.expectStderr?.length ?? 0) > 0)),
      );
      expect(asserts, `${scenario.id} runs commands but checks nothing`).toBe(true);
    }
  });
});

describe('the generated checklist', () => {
  it('exists', () => {
    expect(existsSync(DOC), `${DOC} is missing. Run \`pnpm acceptance:docs\`.`).toBe(true);
  });

  it('matches the catalogue', () => {
    // The same discipline as `schemas:check`: a checklist maintained by hand beside the
    // suite drifts, and a drifted checklist is worse than none because it is believed.
    expect(readFileSync(DOC, 'utf8')).toBe(renderCatalogue());
  });

  it('renders every scenario', () => {
    const rendered = renderCatalogue();
    for (const scenario of SCENARIOS) {
      expect(rendered, scenario.id).toContain(scenario.id);
      expect(rendered, scenario.id).toContain(scenario.title);
    }
  });

  it('renders manual scenarios as a checklist a person can follow', () => {
    const rendered = renderCatalogue();
    const manual = SCENARIOS.filter((scenario) => scenario.mode === 'manual');
    expect(manual.length).toBeGreaterThan(0);
    for (const scenario of manual) {
      const section = rendered.slice(rendered.indexOf(`### \`${scenario.id}\``));
      expect(section, scenario.id).toContain('- [ ]');
      expect(section, scenario.id).toContain('Expect:');
    }
  });
});
