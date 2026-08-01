import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Issue templates are the first thing an outside contributor meets, and nothing executes
 * them, so a mistake in one survives indefinitely. The bug template applied `type:feature`
 * to every bug report filed through it (#150).
 */

const TEMPLATES = join(import.meta.dirname, '..', '..', '..', '.github', 'ISSUE_TEMPLATE');

function labelsOf(file: string): string[] {
  const match = /^labels:\s*\[(.*)\]\s*$/m.exec(readFileSync(join(TEMPLATES, file), 'utf8'));
  return match?.[1] === undefined
    ? []
    : match[1]
        .split(',')
        .map((label) => label.trim().replace(/^["']|["']$/g, ''))
        .filter((label) => label !== '');
}

describe('issue templates', () => {
  it('labels a bug report as a bug', () => {
    expect(labelsOf('bug.yml')).toContain('bug');
    expect(labelsOf('bug.yml')).not.toContain('type:feature');
  });

  it('labels a feature request as a feature', () => {
    expect(labelsOf('feature.yml')).toContain('type:feature');
  });

  it('gives every template at least one label, so nothing lands untriaged', () => {
    const templates = readdirSync(TEMPLATES).filter(
      (file) => file.endsWith('.yml') && file !== 'config.yml',
    );
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(labelsOf(template), `${template} has no labels`).not.toHaveLength(0);
    }
  });

  it('does not ask for output from a command that does not exist yet', () => {
    // `lore doctor` arrives in Phase 3 (#56). Asking for it without saying so makes a
    // reporter think their report is incomplete when it is not.
    const bug = readFileSync(join(TEMPLATES, 'bug.yml'), 'utf8');
    if (!bug.includes('lore doctor')) return;
    expect(bug).toMatch(/if you have it|Phase 3|#56/);
  });
});
