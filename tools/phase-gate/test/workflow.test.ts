import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/phase-gates.yml'), 'utf8');

describe('phase gate workflow', () => {
  it('captures the phase result once and reuses it in the job summary', () => {
    expect(WORKFLOW.match(/pnpm phase:check \$\{\{ matrix\.phase \}\}/g)).toHaveLength(1);
    expect(WORKFLOW).toContain('tee "$RUNNER_TEMP/phase-check.log"');
    expect(WORKFLOW).toContain('cat "$RUNNER_TEMP/phase-check.log"');
  });

  it('installs the browser only for the phase with browser coverage', () => {
    expect(WORKFLOW).toMatch(/if: \$\{\{ matrix\.phase == 4 \}\}/);
    expect(WORKFLOW).toMatch(
      /if: \$\{\{ matrix\.phase == 4 && steps\.browser-cache\.outputs\.cache-hit != 'true' \}\}/,
    );
  });

  it('runs only closed phases on main pushes and keeps manual closure checks available', () => {
    expect(WORKFLOW).toContain("github.event_name == 'push' && fromJSON('[0, 1, 2, 3, 4, 5, 6]')");
    expect(WORKFLOW).toContain('github.event.inputs.phase');
    expect(WORKFLOW).toContain("fromJSON('[0, 1, 2, 3, 4, 5, 6, 7]')");
  });
});
