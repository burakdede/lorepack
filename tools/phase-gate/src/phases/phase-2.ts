import type { PhaseDefinition } from '../types.js';

/**
 * Phase 2, Runtime and AI Interfaces. Every criterion mirrors a promise in epic #3.
 *
 * Written incrementally as tickets land, which is the order #132 established and Phase 1
 * proved cheaper: a gate composed after the fact inherits whatever the suites happened to
 * cover, and Phase 1's gate passed 24 of 24 while the product was unusable once installed.
 *
 * Two criteria exist because of that lesson rather than because a ticket asked for them:
 * `packaging` runs the installed-layout scenario on every phase from here, since this phase
 * adds packages a user receives, and `portability` asserts the runtime cannot reach a
 * backend, because "the same runtime runs on D1" is checkable rather than aspirational.
 */
export const PHASE_2: PhaseDefinition = {
  phase: 2,
  title: 'Runtime & AI Interfaces',
  epic: 3,
  criteria: [
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 2 issue is closed.',
      milestone: 'P2 Runtime & Interfaces',
      allowOpen: [],
    },

    // The capability boundary itself (#41).
    {
      id: 'runtime-interface',
      kind: 'exports',
      promise: 'One capability interface serves every consumer, constructed from ports.',
      module: './packages/runtime/dist/index.js',
      symbols: ['createRuntime'],
    },
    {
      id: 'runtime-ports',
      kind: 'exports',
      promise: 'The ports the runtime reads through are declared in the portable package.',
      module: './packages/core/dist/index.js',
      symbols: ['searchResultSchema', 'buildDescriptionSchema', 'contextBundleSchema'],
    },
    {
      id: 'portability',
      kind: 'command',
      promise:
        'The runtime reaches storage only through ports, so the Phase 6 Worker can supply its own.',
      command: 'pnpm',
      args: ['test:arch'],
      timeoutMs: 300_000,
    },
    {
      id: 'handle-lifecycle',
      kind: 'command',
      promise:
        'Each call acquires one handle and releases it even on error; an in-flight call finishes on its captured build while the next observes the new one.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'runtime'],
      timeoutMs: 300_000,
    },
    {
      id: 'local-ports',
      kind: 'command',
      promise: 'The local ports satisfy the same behaviour against a real build.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'runtime-local'],
      timeoutMs: 300_000,
    },

    // Inherited from Phase 1, because a phase that adds packages can break an install.
    {
      id: 'packaging',
      kind: 'command',
      promise: 'The published files are still enough to install and run the product.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'packaging/'],
      timeoutMs: 600_000,
    },

    // The working agreement requires the next phase to be audited before this one closes.
    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what this phase learned, so it does not rest on disproved assumptions.',
      nextEpic: 4,
      marker: 'Phase 3 audit',
    },
  ],
};
