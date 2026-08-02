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

  {
    id: 'init/unreadable-bytes-are-excluded-not-fatal',
    title: 'A file whose bytes are not text is left out, and the build still succeeds',
    proves:
      'Section 6.9: an unsupported file is excluded with a visible warning. Only a supported file that fails to parse fails the build.',
    mode: 'auto',
    regression: 165,
    fixture: { files: CORPUS, setup: ['init'] },
    steps: [
      {
        action: 'write',
        path: 'guides/screenshot.md',
        contents: '',
        bytes: [0x00, 0x01, 0x02, 0x66, 0xff],
        describe:
          'Write `guides/screenshot.md` containing a NUL byte, so it is binary despite the extension',
      },
      {
        action: 'write',
        path: 'guides/exported.md',
        contents: '',
        bytes: [0xff, 0xfe, 0x68, 0x00],
        describe: 'And `guides/exported.md` as UTF-16, which is what a Windows export produces',
      },
      {
        action: 'run',
        args: ['plan'],
        describe: 'The plan names them before anything is built',
        expect: {
          exitCode: 0,
          stdout: { contains: ['screenshot.md', 'binary', 'exported.md', 'UTF-16'] },
        },
      },
      {
        action: 'run',
        args: ['build'],
        json: true,
        describe: 'The build succeeds, indexing the three readable files and leaving out the two',
        expect: {
          exitCode: 0,
          json: [
            { path: 'counts.artifacts', equals: 3 },
            { path: 'warnings', equals: 2 },
          ],
        },
      },
      {
        action: 'run',
        args: ['inspect', 'warnings'],
        describe: 'Each exclusion is recorded in the build, so it survives the sources',
        expect: {
          exitCode: 0,
          stdout: { contains: ['screenshot.md', 'exported.md', 'not indexed'] },
        },
      },
      {
        action: 'run',
        args: ['status'],
        json: true,
        describe: 'And the project is clean, rather than asking for a build that would do nothing',
        expect: { exitCode: 0, json: [{ path: 'sourceState', equals: 'clean' }] },
      },
      {
        action: 'run',
        args: ['search', 'rollback'],
        json: true,
        describe: 'What is readable is still searchable',
        expect: { exitCode: 0, json: [{ path: 'hits[0].locator.relativePath', exists: true }] },
      },
    ],
  },
];
