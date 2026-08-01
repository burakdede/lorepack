import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * First contact. Invariant 7 says the first run holds no surprises, which in practice means
 * an uninitialised directory explains itself, a dry run writes nothing, and a file that
 * looks like a credential is refused loudly rather than indexed quietly.
 */
export const INIT_SCENARIOS: readonly Scenario[] = [
  {
    id: 'init/uninitialised-explains-itself',
    title: 'A command in a directory with no project says what to do',
    proves: 'Invariant 7: no surprises on first run. Errors carry remediation (section 4.4).',
    mode: 'auto',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'run',
        args: ['status'],
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_NOT_INITIALIZED',
          stderr: { contains: ['lore init'] },
        },
      },
    ],
  },

  {
    id: 'init/dry-run-writes-nothing',
    title: '`lore init --dry-run` reports what it would do and changes nothing',
    proves: 'Section 4.6: a plan never mutates. The escape hatch is safe to try.',
    mode: 'auto',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'run',
        args: ['init', '--dry-run'],
        expect: {
          exitCode: 0,
          stdout: { contains: ['Would create', 'lore.yaml', '.loreignore'] },
        },
      },
      {
        action: 'run',
        args: ['status'],
        describe: 'Confirm the project is still uninitialised',
        expect: { exitCode: 1, errorCode: 'LORE_E_NOT_INITIALIZED' },
      },
    ],
  },

  {
    id: 'init/creates-the-project-files',
    title: '`lore init` creates the configuration a build needs, and nothing else',
    proves: 'Section 4.6: one command produces a working project.',
    mode: 'auto',
    fixture: { files: CORPUS },
    steps: [
      {
        action: 'run',
        args: ['init'],
        expect: {
          exitCode: 0,
          stdout: { contains: ['lore.yaml', '.loreignore', '.gitignore', 'lore build'] },
        },
      },
      {
        action: 'run',
        args: ['plan'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'artifacts.added', equals: 3 },
            { path: 'activeBuildId', equals: null },
          ],
        },
      },
    ],
  },

  {
    id: 'init/nested-project-refused',
    title: '`lore init` inside an existing project is refused and says why',
    proves: 'Section 8.1: one project root. A nested project would make the build ambiguous.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init'] },
    steps: [
      { action: 'write', path: 'sub/notes.md', contents: '# Nested\n' },
      {
        action: 'run-in',
        project: 'project/sub',
        args: ['init'],
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_INVALID_ARGUMENT',
          stderr: { contains: ['already inside a Lorepack project', 'Nested projects'] },
        },
      },
    ],
  },

  {
    id: 'init/credential-shaped-files-never-indexed',
    title: 'Files whose names look like credentials are named at init and never indexed',
    proves: 'Section 19.2: a filename guardrail, stated to the user rather than silent.',
    mode: 'auto',
    fixture: {
      files: {
        ...CORPUS,
        '.env': 'API_KEY=sk-live-not-a-real-key\n',
        id_rsa: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n',
      },
    },
    steps: [
      {
        action: 'run',
        args: ['init'],
        expect: {
          exitCode: 0,
          stdout: { contains: ['look like credentials', '.env', 'id_rsa', 'not a secret scanner'] },
        },
      },
      { action: 'run', args: ['build'], expect: { exitCode: 0 } },
      {
        action: 'run',
        args: ['inspect', 'sources'],
        expect: { exitCode: 0, stdout: { excludes: ['.env', 'id_rsa'] } },
      },
      {
        action: 'run',
        args: ['search', 'sk-live-not-a-real-key'],
        expect: { exitCode: 0, stdout: { contains: ['No matches'] } },
      },
    ],
  },
];
