import type { Scenario } from '../types.js';
import { CORPUS, EDITED_ONBOARDING } from './corpus.js';

/**
 * The product. Section 21's exit criterion is behavioural: editing one file creates a new
 * immutable version, shows a correct diff, and rolls back without re-indexing. These
 * scenarios are that sentence, taken one clause at a time.
 */
export const LIFECYCLE_SCENARIOS: readonly Scenario[] = [
  {
    id: 'lifecycle/plan-predicts-the-build',
    title: 'What `lore plan` promises is what `lore build` does',
    proves: 'Section 4.6: plan is a preview, not a guess.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init'] },
    steps: [
      {
        action: 'run',
        args: ['plan'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'artifacts.added', equals: 3 },
            { path: 'artifacts.reused', equals: 0 },
            { path: 'capabilities.next[0]', equals: 'lexical-search' },
          ],
        },
      },
      {
        action: 'run',
        args: ['build'],
        json: true,
        capture: { first: 'buildId' },
        expect: {
          exitCode: 0,
          json: [
            { path: 'counts.artifacts', equals: 3 },
            { path: 'created', equals: true },
            { path: 'activated', equals: true },
          ],
        },
      },
      {
        action: 'run',
        args: ['status'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'sourceState', equals: 'clean' },
            { path: 'activeBuildId', equalsCapture: 'first' },
            { path: 'decidedBy', equals: 'content-hash' },
          ],
        },
      },
    ],
  },

  {
    id: 'lifecycle/editor-save-is-detected',
    title: 'An editor-style save is seen as a change, and rebuilt incrementally',
    proves: 'Section 18.2: dirtiness is decided by content, and unchanged artifacts are reused.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        // Editors write a sibling and rename over the target. On Windows that is the case
        // naive file handling gets wrong, so the scenario saves the way an editor does.
        action: 'write',
        path: 'guides/onboarding.md',
        contents: EDITED_ONBOARDING,
        atomic: true,
        describe: 'Edit one file the way an editor saves it, by rename over the original',
      },
      {
        action: 'run',
        args: ['status'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'sourceState', equals: 'dirty' },
            { path: 'artifacts.changed', equals: 1 },
            { path: 'artifacts.added', equals: 0 },
          ],
        },
      },
      {
        action: 'run',
        args: ['status', '--exit-code'],
        describe: 'Confirm dirty sources are scriptable',
        expect: { exitCode: 2 },
      },
      {
        action: 'run',
        args: ['build'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'reusedArtifacts', equals: 2 },
            { path: 'rebuiltArtifacts', equals: 1 },
            { path: 'created', equals: true },
          ],
        },
      },
    ],
  },

  {
    id: 'lifecycle/diff-reads-builds-not-sources',
    title: 'Two builds are compared without reading a single source file',
    proves: 'Invariant 1: the build is the source of truth, so a diff needs nothing else.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'write', path: 'guides/onboarding.md', contents: EDITED_ONBOARDING, atomic: true },
      { action: 'run', args: ['build'], expect: { exitCode: 0 } },
      {
        action: 'empty-sources',
        describe: 'Empty every source file, so a diff that reads them cannot succeed',
      },
      {
        action: 'run',
        args: ['diff'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'artifacts.changed', equals: 1 },
            { path: 'artifacts.changes[0].path', equals: 'guides/onboarding.md' },
            { path: 'chunks.added', atLeast: 1 },
            { path: 'identical', equals: false },
          ],
        },
      },
    ],
  },

  {
    id: 'lifecycle/rollback-without-reindexing',
    title: 'Rollback restores an earlier build with every source file emptied',
    proves: 'Section 21 and invariant 4: rollback is a pointer change and never recompiles.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['builds'],
        json: true,
        capture: { first: 'builds[0].buildId' },
      },
      { action: 'write', path: 'guides/onboarding.md', contents: EDITED_ONBOARDING, atomic: true },
      { action: 'run', args: ['build'], json: true, capture: { second: 'buildId' } },
      {
        // Counting parse work can be satisfied by an accidental cache hit. An empty source
        // tree cannot: if rollback re-indexed at all, the restored build would be empty.
        action: 'empty-sources',
        describe: 'Empty every source file',
      },
      {
        action: 'run',
        args: ['rollback'],
        expect: { exitCode: 0, stdout: { contains: ['{{first}}'] } },
      },
      {
        action: 'run',
        args: ['search', 'VPN access'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'buildId', equalsCapture: 'first' },
            { path: 'hits[0].locator.relativePath', exists: true },
          ],
        },
      },
      {
        action: 'run',
        args: ['activate', '{{second}}'],
        describe: 'Move forward again, which is the same pointer change in reverse',
        expect: { exitCode: 0 },
      },
      {
        action: 'run',
        args: ['status'],
        json: true,
        expect: { exitCode: 0, json: [{ path: 'activeBuildId', equalsCapture: 'second' }] },
      },
    ],
  },

  {
    id: 'lifecycle/search-carries-provenance',
    title: 'Every search result names the file, heading path and lines it came from',
    proves: 'Invariant 5: a result without a SourceLocator is a bug, not a style issue.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['search', 'rollback'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'hits[0].locator.relativePath', matches: '^guides/deployment\\.md$' },
            { path: 'hits[0].locator.headingPath[0]', equals: 'Deployment' },
            { path: 'hits[0].locator.lineStart', atLeast: 1 },
            { path: 'hits[0].locator.artifactId', exists: true },
            { path: 'sourceState', equals: 'clean' },
          ],
        },
      },
      {
        action: 'run',
        args: ['search', 'rollback'],
        describe: 'The human rendering carries the same provenance',
        expect: { exitCode: 0, stdout: { matches: ['guides/deployment\\.md:\\d+'] } },
      },
    ],
  },

  {
    id: 'lifecycle/inspect-survives-the-sources',
    title: '`lore inspect` explains a build after its sources are gone',
    proves: 'Section 4.9: inspection reads sealed build data, so it keeps working.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'empty-sources' },
      {
        action: 'run',
        args: ['inspect', 'sources'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'artifacts[0].displayPath', equals: 'guides/deployment.md' },
            { path: 'artifacts[0].parserId', equals: 'markdown' },
            { path: 'artifacts[0].authority', equals: 50 },
          ],
        },
      },
      {
        action: 'run',
        args: ['inspect', 'warnings'],
        json: true,
        expect: { exitCode: 0, json: [{ path: 'total', equals: 0 }] },
      },
      {
        action: 'run',
        args: ['inspect', 'build'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'canonicalRoots.artifacts', matches: '^[0-9a-f]{64}$' },
            { path: 'compilerVersion', exists: true },
          ],
        },
      },
    ],
  },

  {
    id: 'lifecycle/earlier-builds-stay-readable',
    title: 'Rolling back leaves the newer build on disk and inspectable',
    proves: 'Invariant 4: rollback moves a pointer. It never destroys what it moved away from.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'run', args: ['builds'], json: true, capture: { first: 'builds[0].buildId' } },
      { action: 'write', path: 'notes/standup.txt', contents: 'Rewritten note.\n', atomic: true },
      { action: 'run', args: ['build'], json: true, capture: { second: 'buildId' } },
      { action: 'run', args: ['rollback'], expect: { exitCode: 0 } },
      {
        action: 'run',
        args: ['builds'],
        json: true,
        describe: 'Both builds are still listed, and the older one is active again',
        expect: {
          exitCode: 0,
          json: [
            { path: 'builds[1]', exists: true },
            { path: 'activeBuildId', equalsCapture: 'first' },
          ],
        },
      },
      {
        action: 'run',
        args: ['inspect', 'build', '--build', '{{second}}'],
        json: true,
        describe: 'Inspect the build that is no longer active',
        expect: { exitCode: 0, json: [{ path: 'buildId', equalsCapture: 'second' }] },
      },
      {
        action: 'run',
        args: ['diff', '{{first}}', '{{second}}'],
        json: true,
        describe: 'And diff across the rollback, in both directions of history',
        expect: { exitCode: 0, json: [{ path: 'identical', equals: false }] },
      },
    ],
  },

  {
    id: 'lifecycle/pruned-build-cannot-be-activated',
    title: 'Activating a build that no longer exists fails and lists what does',
    proves: 'Section 4.4: an error names the subject and the way forward.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'run', args: ['builds'], json: true, capture: { first: 'builds[0].buildId' } },
      { action: 'write', path: 'guides/onboarding.md', contents: EDITED_ONBOARDING, atomic: true },
      { action: 'run', args: ['build'], expect: { exitCode: 0 } },
      {
        action: 'run',
        args: ['prune', '--keep', '0', '--yes'],
        expect: { exitCode: 0, stdout: { contains: ['{{first}}'] } },
      },
      {
        action: 'run',
        args: ['activate', '{{first}}'],
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_BUILD_NOT_FOUND',
          stderr: { contains: ['Available builds'] },
        },
      },
    ],
  },
];
