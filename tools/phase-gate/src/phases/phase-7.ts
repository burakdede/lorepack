import type { PhaseDefinition } from '../types.js';

/**
 * Phase 7, open-source hardening and v0.1 release. Every criterion mirrors a promise
 * in epic #8 and the release issue #102.
 *
 * This gate proves the release is ready to dispatch. It deliberately does not claim the
 * irreversible publish has already happened while #102 is still open. The release issue
 * remains the authority for the final npm publish, GitHub release, provenance check and
 * post-publish smoke.
 */
export const PHASE_7: PhaseDefinition = {
  phase: 7,
  title: 'Hardening and v0.1 release',
  epic: 8,
  criteria: [
    {
      id: 'issues-ready',
      kind: 'issues',
      promise:
        'Phase 7 has no open implementation work except the release issue and the epic while the real publish is pending.',
      milestone: 'P7 Hardening & v0.1',
      allowOpen: [8, 102, 310],
    },
    {
      id: 'success-matrix',
      kind: 'path',
      promise:
        'The sixteen v0.1 success criteria are mapped to committed evidence before the release is dispatched.',
      paths: ['docs/compatibility/v0.1-success-matrix.md'],
    },
    {
      id: 'release-docs',
      kind: 'path',
      promise:
        'The release checklist, compatibility matrix, package format, CLI reference and demo transcript are published beside the code they describe.',
      paths: [
        'docs/release-checklist.md',
        'docs/compatibility/README.md',
        'docs/package-format/README.md',
        'docs/cli-reference.md',
        'docs/demo-transcript.md',
        'docs/architecture/release-supply-chain.md',
      ],
    },
    {
      id: 'release-workflow',
      kind: 'path',
      promise:
        'The v0.1 release path is automated through the checked-in workflow rather than a manual publish from a laptop.',
      paths: ['.github/workflows/release.yml'],
    },
    {
      id: 'supply-chain',
      kind: 'command',
      promise:
        'Apache licensing, npm provenance policy, dependency health, SBOM and production audit are checked before release.',
      command: 'pnpm',
      args: ['check:supply-chain'],
      timeoutMs: 300_000,
    },
    {
      id: 'release-policy',
      kind: 'command',
      promise:
        'The release workflow enforces dry runs, stable-release inputs, SBOM artifacts and npm provenance.',
      command: 'pnpm',
      args: ['check:release-policy'],
      timeoutMs: 300_000,
    },
    {
      id: 'performance-report',
      kind: 'command',
      promise:
        'The v0.1 performance report is backed by committed measurements and does not advertise unmet gates.',
      command: 'pnpm',
      args: ['check:performance-report'],
      timeoutMs: 300_000,
    },
    {
      id: 'clean-install',
      kind: 'command',
      promise:
        'The default install keeps the zero-surprise first-run promise: no native add-on and no install hook reaches users.',
      command: 'pnpm',
      args: ['check:no-native'],
      timeoutMs: 300_000,
    },
    {
      id: 'acceptance-docs',
      kind: 'command',
      promise:
        'The recorded acceptance checklist matches the checked-in end-to-end scenario catalogue.',
      command: 'pnpm',
      args: ['acceptance:docs:check'],
      timeoutMs: 600_000,
    },
    {
      id: 'cli-docs',
      kind: 'command',
      promise: 'The public CLI reference matches the command definitions a user installs.',
      command: 'pnpm',
      args: ['cli:docs:check'],
      timeoutMs: 600_000,
    },
    {
      id: 'readme-demo',
      kind: 'command',
      promise:
        'The README demo sequence runs against the checked-in examples in under the documented release path.',
      command: 'pnpm',
      args: ['demo:readme:check'],
      timeoutMs: 900_000,
    },
    {
      id: 'phase-8-audit',
      kind: 'audit',
      promise:
        'The deferred Phase 8 backlog was audited before Phase 7 closes, so post-v0.1 work does not leak into v0.1.',
      nextEpic: 110,
      marker: 'Phase 8 audit',
    },
  ],
};
