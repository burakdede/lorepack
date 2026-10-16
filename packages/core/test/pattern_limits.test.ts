import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { ruleSchema } from '../src/schemas/config.js';

const repeated = 'a*a*a*a*a*a*a*a*a*a*a*a*a*z';

it.each(['match', 'supersedes'] as const)(
  'rejects oversized %s patterns at the schema boundary',
  (field) => {
    const rule =
      field === 'match'
        ? { match: 'a'.repeat(513), authority: 80 }
        : { match: '*.md', supersedes: ['a'.repeat(513)] };
    expect(ruleSchema.safeParse(rule).success).toBe(false);
  },
);

it.each(['match', 'supersedes'] as const)(
  'rejects repeated-star %s patterns at the schema boundary',
  (field) => {
    const rule =
      field === 'match'
        ? { match: repeated, authority: 80 }
        : { match: '*.md', supersedes: [repeated] };
    expect(ruleSchema.safeParse(rule).success).toBe(false);
  },
);

it('accepts exact limits and stars in separate path segments', () => {
  for (const match of [
    'a'.repeat(512),
    'a*b*c*d*e',
    '**/docs/**/draft-*.md',
    'one*/two*/three*/four*/five*',
  ]) {
    expect(ruleSchema.safeParse({ match, authority: 80 }).success, match).toBe(true);
  }
});

it('names the invalid rule field and YAML location in the actual loader', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': `version: 1\nname: bounded\nsources: [.]\nrules:\n  - match: '${repeated}'\n    authority: 80\n`,
        'a.md': '# A',
      },
    },
    ({ root }) => {
      expect(() => loadConfig({ cwd: root })).toThrowError(
        expect.objectContaining({
          code: 'LORE_E_CONFIG_INVALID',
          path: 'lore.yaml',
          message: expect.stringMatching(/rules\.0\.match.*line 5/),
        }),
      );
    },
  );
});

it('does not treat rule escapes as path separators for the star budget', () => {
  expect(ruleSchema.safeParse({ match: 'a*\\a*\\a*\\a*\\a*z', authority: 80 }).success).toBe(false);
});
