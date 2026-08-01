import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * Section 20.3 lists four conditions. Two of them a single machine can check, and they are
 * here. The Windows against POSIX condition comes from running this suite on the CI matrix,
 * which is why the scenarios carry no platform skip.
 */
export const DETERMINISM_SCENARIOS: readonly Scenario[] = [
  {
    id: 'determinism/same-id-from-a-second-path',
    title: 'The same sources build to the same id from a different absolute path',
    proves: 'Invariant 3: absolute paths never reach build identity.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'run', args: ['builds'], json: true, capture: { here: 'builds[0].buildId' } },
      {
        action: 'clone',
        as: 'elsewhere',
        describe: 'Copy the sources and configuration to a second absolute path',
      },
      {
        action: 'run-in',
        project: 'elsewhere',
        args: ['build'],
        json: true,
        expect: { exitCode: 0, json: [{ path: 'buildId', equalsCapture: 'here' }] },
      },
      {
        // The whole manifest, not only the id: identity is worthless if the record
        // describing it differs. Operational facts live in the receipt, outside this file.
        action: 'identical',
        as: 'json',
        left: { path: '.lore/builds/{{here}}/manifest.json' },
        right: { project: 'elsewhere', path: '.lore/builds/{{here}}/manifest.json' },
        describe: 'Compare the two manifests, key order aside',
      },
    ],
  },

  {
    id: 'determinism/archives-match-byte-for-byte',
    title: 'Two workspaces on one machine pack byte-identical archives',
    proves: 'Section 12.8: a `.lorepack` is reproducible, not merely equivalent.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        // Cloned before either project packs. An archive left in the tree is discovered as
        // a source, so packing first would change what the second project builds, and the
        // scenario would fail for a reason that has nothing to do with reproducibility.
        action: 'clone',
        as: 'elsewhere',
      },
      { action: 'run-in', project: 'elsewhere', args: ['build'], expect: { exitCode: 0 } },
      { action: 'run', args: ['pack', '--out', 'out.lorepack'], expect: { exitCode: 0 } },
      {
        action: 'run-in',
        project: 'elsewhere',
        args: ['pack', '--out', 'out.lorepack'],
        expect: { exitCode: 0 },
      },
      {
        // Across machines only the manifest and canonical roots must agree, because
        // `context.sqlite` page layout is explicitly not part of build identity (11.3).
        // Across two directories on one machine there is no such excuse.
        action: 'identical',
        as: 'bytes',
        left: { path: 'out.lorepack' },
        right: { project: 'elsewhere', path: 'out.lorepack' },
      },
    ],
  },

  {
    id: 'determinism/rebuild-is-a-no-op',
    title: 'Rebuilding unchanged sources produces the same id and creates nothing',
    proves: 'Invariant 3, and section 18.2: identical canonical inputs are one build.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      { action: 'run', args: ['builds'], json: true, capture: { first: 'builds[0].buildId' } },
      { action: 'record', name: 'after-first-build' },
      {
        action: 'run',
        args: ['build'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            { path: 'buildId', equalsCapture: 'first' },
            { path: 'created', equals: false },
          ],
        },
      },
      {
        action: 'unchanged',
        name: 'after-first-build',
        describe: 'No second build directory appeared, and the pointer did not move',
      },
    ],
  },
];
