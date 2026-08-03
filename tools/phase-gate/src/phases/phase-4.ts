import type { PhaseDefinition } from '../types.js';

/**
 * Phase 4, Studio. Every criterion mirrors a promise in epic #5.
 *
 * Written incrementally as tickets land, which is the order #132 established. Phase 1 proved
 * the alternative expensive: a gate composed after the fact inherits whatever the suites
 * happened to cover, and passed 24 of 24 while the product was unusable once installed.
 *
 * Two criteria here exist because of what this phase found rather than because a ticket asked
 * for them. `write-surface` exists because Studio introduced the first routes in this product
 * that can change anything, and `bundle-budget` exists because invariant 7 is only true while
 * Studio ships as static files that need no toolchain and no network.
 */
export const PHASE_4: PhaseDefinition = {
  phase: 4,
  title: 'Studio',
  epic: 5,
  criteria: [
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 4 issue is closed.',
      milestone: 'P4 Studio',
      allowOpen: [],
    },

    // The design direction, which every route is built against (#64).
    {
      id: 'design-direction',
      kind: 'path',
      promise:
        'Studio has a written visual direction with named references and an anti-brief, so its look is a decision rather than a default.',
      paths: ['docs/architecture/studio-design.md', 'docs/architecture/studio.md'],
    },
    {
      id: 'shell',
      kind: 'command',
      promise:
        'The build being inspected is on screen permanently, and every route is reachable without a page reload.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'studio', 'shell'],
      timeoutMs: 300_000,
    },

    // The routes (#65, #66, #67, #68).
    {
      id: 'overview',
      kind: 'command',
      promise:
        'The first screen answers what this build contains and whether the sources have moved on, without claiming a conflict was detected.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'studio', 'overview'],
      timeoutMs: 300_000,
    },
    {
      id: 'sources',
      kind: 'command',
      promise:
        'Exactly what was parsed, and exactly what was not, with the exclusions one click away rather than in an appendix.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'studio', 'sources'],
      timeoutMs: 300_000,
    },
    {
      id: 'playground',
      kind: 'command',
      promise:
        'Assembly is inspectable: every selection carries provenance, every omission carries a reason, and no score is presented as truth.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'studio', 'playground'],
      timeoutMs: 300_000,
    },
    {
      id: 'versions',
      kind: 'command',
      promise:
        'Every build-changing action shows a plan, names its target build and is confirmed before anything moves.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'studio', 'versions'],
      timeoutMs: 300_000,
    },

    {
      id: 'diagnostics',
      kind: 'command',
      promise:
        'Everything `lore doctor` knows is visible in the browser, with the remediation intact and no aggregate score invented.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'studio', 'diagnostics'],
      timeoutMs: 300_000,
    },

    // What Studio needed from the server, and the boundary it must not cross.
    {
      id: 'export-parity',
      kind: 'command',
      promise:
        'What Studio copies is byte-identical to what `lore export` writes, because one renderer produces both.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'contract', 'serve'],
      timeoutMs: 600_000,
    },
    {
      id: 'write-surface',
      kind: 'command',
      promise:
        'The only routes that change anything exist solely where a local host supplied them, and refuse every origin but this machine.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'runtime', 'http'],
      timeoutMs: 300_000,
    },
    {
      id: 'lifecycle-from-studio',
      kind: 'command',
      promise:
        'A build activated in Studio is the build MCP answers from on its next call, with no restart.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'dev.e2e'],
      timeoutMs: 900_000,
    },

    // Invariant 7, which Studio is the first thing in this product that could break.
    {
      id: 'bundle-budget',
      kind: 'command',
      promise:
        'Studio ships as static files within a documented budget: no toolchain, no network, no model download.',
      command: 'pnpm',
      args: ['check:studio-bundle'],
      timeoutMs: 120_000,
    },

    // The working agreement requires the next phase to be audited before this one closes.
    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what this phase learned, so it does not rest on disproved assumptions.',
      nextEpic: 6,
      marker: 'Phase 5 audit',
    },
  ],
};
