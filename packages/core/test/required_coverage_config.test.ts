import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';

const minimal = 'version: 1\nname: required\nsources: [docs]\n';

it('keeps coverage permissive with no declarations by default', async () => {
  await withTempProject({ files: { 'lore.yaml': minimal, 'docs/a.md': 'Read me.' } }, (project) => {
    expect(loadConfig({ cwd: project.root }).effective).toMatchObject({
      build: { profile: 'permissive', required: [] },
    });
  });
});

it('loads exact project-relative artifacts and exact worksheet names under a strict profile', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': `${minimal}build:\n  profile: strict\n  required:\n    - path: docs/report.pdf\n    - path: docs/budget.xlsx\n      sheets: [Revenue, Costs]\n`,
        'docs/a.md': 'Read me.',
      },
    },
    (project) => {
      expect(loadConfig({ cwd: project.root }).effective).toMatchObject({
        build: {
          profile: 'strict',
          required: [
            { path: 'docs/budget.xlsx', sheets: ['Costs', 'Revenue'] },
            { path: 'docs/report.pdf' },
          ],
        },
      });
    },
  );
});

it.each([
  '../outside.pdf',
  '/absolute.pdf',
  'C:/absolute.pdf',
  'docs\\report.pdf',
  'docs/../report.pdf',
  './docs/report.pdf',
  'docs//report.pdf',
  'docs/*.pdf',
])('rejects a noncanonical required artifact path: %s', async (path) => {
  await withTempProject(
    {
      files: {
        'lore.yaml': `${minimal}build:\n  required:\n    - path: ${JSON.stringify(path)}\n`,
        'docs/a.md': 'Read me.',
      },
    },
    (project) => {
      expect(() => loadConfig({ cwd: project.root })).toThrow(/lore.yaml is invalid/);
    },
  );
});

it.each([
  'profile: strictest',
  'required: [{path: docs/report.pdf}, {path: docs/report.pdf}]',
  'required: [{path: docs/budget.xlsx, sheets: []}]',
  'required: [{path: docs/budget.xlsx, sheets: [Revenue, Revenue]}]',
  'required: [{path: docs/budget.xlsx, sheets: [""]}]',
  'required: [{path: docs/report.pdf, unknown: true}]',
])('rejects malformed required coverage: %s', async (setting) => {
  await withTempProject(
    {
      files: {
        'lore.yaml': `${minimal}build:\n  ${setting}\n`,
        'docs/a.md': 'Read me.',
      },
    },
    (project) => {
      expect(() => loadConfig({ cwd: project.root })).toThrow(/lore.yaml is invalid/);
    },
  );
});
