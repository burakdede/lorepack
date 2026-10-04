import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUDIO_SETUP_TIMEOUT_MS } from '../../../tools/studio-e2e/test/setup-budget.js';

const root = join(import.meta.dirname, '../../..');

describe('Studio E2E setup budget', () => {
  it('uses one explicit budget for Playwright and server readiness', () => {
    const config = readFileSync(join(root, 'tools/studio-e2e/playwright.config.ts'), 'utf8');
    const fixture = readFileSync(join(root, 'tools/studio-e2e/test/fixture.ts'), 'utf8');

    expect(STUDIO_SETUP_TIMEOUT_MS).toBe(180_000);
    expect(config).toContain('timeout: STUDIO_SETUP_TIMEOUT_MS');
    expect(fixture).toContain('Date.now() + STUDIO_SETUP_TIMEOUT_MS');
    expect(fixture).toContain('Studio E2E setup failed during lore');
    expect(fixture).toContain('Studio E2E setup failed while waiting for lore dev');
  });
});
