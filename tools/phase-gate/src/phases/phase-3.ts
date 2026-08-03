import type { PhaseDefinition } from '../types.js';

/**
 * Phase 3, the two-command local product. Every criterion mirrors a promise in epic #4.
 *
 * Written incrementally as tickets landed, which is the order #132 established and Phase 1
 * proved cheaper the hard way: a gate composed after the fact inherits whatever the suites
 * happened to cover, and Phase 1's passed 24 of 24 while the product was unusable once
 * installed.
 *
 * Two criteria are here because of what this phase found rather than because a ticket asked.
 * `windows` exists because every defect CI caught in this phase was a Windows one and none
 * were visible locally, and `clean-install` exists because invariant 7 was an assertion until
 * something tried to install with lifecycle scripts suppressed.
 */
export const PHASE_3: PhaseDefinition = {
  phase: 3,
  title: 'Two-Command Local Product',
  epic: 4,
  criteria: [
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 3 issue is closed.',
      milestone: 'P3 Two-Command DX',
      allowOpen: [],
    },

    // The supervisor and what it composes (#53, #54, #55).
    {
      id: 'dev-command',
      kind: 'command',
      promise:
        'One command takes an unconfigured folder to a running, watching, connected runtime, and stops cleanly.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'dev.e2e'],
      timeoutMs: 600_000,
    },
    {
      id: 'watch-correctness',
      kind: 'command',
      promise:
        'The watcher accelerates and content hashes decide: a burst is one rebuild, identical content is none, and a missed event still converges.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'watch.test'],
      timeoutMs: 600_000,
    },
    {
      id: 'dev-session',
      kind: 'command',
      promise:
        'The session is discoverable on the documented port, refuses a second supervisor, and leaves no receipt behind a process that is gone.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'dev-session'],
      timeoutMs: 300_000,
    },

    // Diagnostics and configuration (#56, #57).
    {
      id: 'doctor',
      kind: 'command',
      promise: 'One command names what is wrong with an environment and how to fix it.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'doctor'],
      timeoutMs: 300_000,
    },
    {
      id: 'doctor-contract',
      kind: 'path',
      promise:
        'The diagnostic report is a published contract, so Studio renders it rather than reimplementing the checks.',
      paths: ['schemas/doctor-report.json'],
    },
    {
      id: 'effective-configuration',
      kind: 'command',
      promise:
        'Every resolved value carries the layer that supplied it, and says whether it participates in the build id.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'config-resolve'],
      timeoutMs: 300_000,
    },

    // Connecting a client (#58, #59, #60).
    {
      id: 'connector-port',
      kind: 'exports',
      promise:
        'Connectors are registered explicitly behind one port, and the orchestrator owns the safety.',
      module: './packages/connect-clients/dist/index.js',
      symbols: ['createClaudeCodeConnector', 'verifyStdioServer', 'renderVerifiedSnippet'],
    },
    {
      id: 'connector-safety',
      kind: 'command',
      promise:
        'Editing a client configuration merges, backs up, renames into place, and removes only what Lorepack created.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'connect-clients'],
      timeoutMs: 600_000,
    },
    {
      id: 'claude-code-integration',
      kind: 'path',
      promise:
        'The verified client, its exact version and the date are recorded, and the human step is a checklist rather than folklore.',
      paths: [
        'docs/integrations/claude-code.md',
        'docs/compatibility/milestone-1-manual-checklist.md',
      ],
    },

    // What CI found that a local run never would (#61, #62).
    {
      id: 'windows',
      kind: 'command',
      promise:
        'Identifiers stay POSIX while filesystem calls stay native, and the paths handed to the operating system are canonical.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'windows'],
      timeoutMs: 300_000,
    },
    {
      id: 'windows-documented',
      kind: 'path',
      promise: 'The platform traps this phase found are written down rather than rediscovered.',
      paths: ['docs/compatibility/windows.md', 'docs/architecture/watch.md'],
    },
    {
      id: 'clean-install',
      kind: 'command',
      promise: 'Nothing compiles, downloads or needs a toolchain at install time, on any platform.',
      command: 'pnpm',
      args: ['check:no-native'],
      timeoutMs: 300_000,
    },

    // The milestone as a person experiences it (#63).
    {
      id: 'two-command-flow',
      kind: 'command',
      promise:
        'Two commands take a folder to a grounded, cited answer, and an unverified client gets an honest snippet rather than a refusal.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'dev/'],
      timeoutMs: 900_000,
    },
    {
      id: 'packaging',
      kind: 'command',
      promise: 'The published files are still enough to install and run the product.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'packaging/'],
      timeoutMs: 900_000,
    },

    // The working agreement requires the next phase to be audited before this one closes.
    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what this phase learned, so it does not rest on disproved assumptions.',
      nextEpic: 5,
      marker: 'Phase 4 audit',
    },
  ],
};
