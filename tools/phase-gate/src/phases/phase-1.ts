import type { PhaseDefinition } from '../types.js';

/**
 * Phase 1, the Lifecycle Vertical Slice. Every criterion mirrors a promise in epic #2: its
 * three exit criteria, its stated deliverable, and each row of its capability list.
 *
 * Written while the phase was being built rather than after it closed. Phase 0 did it the
 * other way, discovered its verification had been uneven, and paid for the gap in #128.
 */
export const PHASE_1: PhaseDefinition = {
  phase: 1,
  title: 'Lifecycle Vertical Slice',
  epic: 2,
  criteria: [
    // Exit criterion 1: the Milestone 0 exit criterion, section 21.
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 1 issue is closed.',
      milestone: 'P1 Lifecycle Slice',
      allowOpen: [],
    },
    {
      // Cites the acceptance catalogue rather than a test name. A `-t` pattern is satisfied
      // by anything that happens to be called that, and stops matching when someone renames
      // a describe block; a scenario id is the thing the checklist and the report both name.
      id: 'milestone-0',
      kind: 'command',
      promise:
        'Editing one file creates a new immutable version, shows a correct diff, and rolls back without re-indexing.',
      command: 'pnpm',
      args: ['acceptance'],
      timeoutMs: 900_000,
    },

    // Exit criterion 2: section 20.3. The Windows against POSIX half comes from CI.
    {
      id: 'determinism',
      kind: 'command',
      promise:
        'The same project builds to the identical build id twice, from different absolute paths, and in any enumeration order.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'determinism/'],
      timeoutMs: 300_000,
    },

    // Exit criterion 3, asserted the way Phase 0 proved it: empty the sources first.
    {
      id: 'rollback-without-reindex',
      kind: 'command',
      promise: 'Rollback performs zero parse or index work, even with every source emptied.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'rollback-without-reindexing'],
      timeoutMs: 300_000,
    },

    // The deliverable, and the class of regression prose cannot catch: a command that
    // quietly stops being registered.
    {
      id: 'command-set',
      kind: 'exports',
      promise:
        'The binary still exposes init, plan, build, status, search, diff, activate, rollback, builds, prune, inspect and pack.',
      module: './packages/cli/dist/commands/index.js',
      symbols: ['registerCommands'],
    },
    {
      id: 'commands-registered',
      kind: 'command',
      promise: 'Every command Phase 1 ships is listed by `lore --help`.',
      command: 'node',
      args: ['scripts/check-command-set.mjs'],
    },

    // Capability: ingestion end to end.
    {
      id: 'parsers',
      kind: 'exports',
      promise: 'Markdown and plain text are ingested end to end.',
      module: './packages/parsers/dist/index.js',
      symbols: ['markdownParser', 'textParser', 'parserFor'],
    },

    // Capability: discovery, path safety, case collisions.
    {
      id: 'discovery',
      kind: 'exports',
      promise:
        'Discovery honours .loreignore and safe defaults, and refuses path escape and case collisions.',
      module: './packages/compiler/dist/index.js',
      symbols: ['discover', 'readIgnoreRules', 'createMatcher'],
    },

    // Capability: fingerprinting and the reuse cache.
    {
      id: 'fingerprint-cache',
      kind: 'exports',
      promise: 'Content fingerprinting decides dirtiness, and unchanged artifacts are reused.',
      module: './packages/compiler/dist/index.js',
      symbols: ['fingerprintSources', 'compareFingerprints', 'cacheKey'],
    },

    // Capability: normalization, chunking, lexical index.
    {
      id: 'normalize-chunk',
      kind: 'exports',
      promise: 'Content is canonically normalized and chunked with its hierarchy preserved.',
      module: './packages/compiler/dist/index.js',
      symbols: ['normalizeArtifact', 'chunkArtifact', 'estimateTokens'],
    },
    {
      id: 'fts5-available',
      kind: 'command',
      promise: 'The SQLite build in use has FTS5, so lexical search can work at all.',
      command: 'pnpm',
      args: ['probe:fts5'],
    },

    // Capability: validation and sealing.
    {
      id: 'validate-and-seal',
      kind: 'exports',
      promise:
        'A candidate is validated before it is sealed, so a failed build cannot corrupt the active version.',
      module: './packages/compiler/dist/index.js',
      symbols: ['validateCandidate'],
    },
    {
      id: 'build-orchestration',
      kind: 'command',
      promise:
        'A build validates, seals atomically, activates as a pointer change, and leaves builds/ untouched when cancelled.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', '-t', 'lore build'],
      timeoutMs: 300_000,
    },
    {
      // Separated from `build-orchestration` because it passed for a year while the promise
      // was false. Those tests abort a controller they own, which proves the checkpoints
      // read the flag and never proves a signal can reach them (#146). This criterion runs
      // the scenarios that send a real signal to a real process.
      id: 'cancellation',
      kind: 'command',
      promise:
        'A real interrupt stops a build and leaves builds/ and the active pointer unchanged.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'cancellation/'],
      timeoutMs: 600_000,
    },

    // Capability: the lockfile.
    {
      id: 'lockfile',
      kind: 'exports',
      promise:
        'Every version that can change build output is recorded, and --frozen fails on drift.',
      module: './packages/compiler/dist/index.js',
      symbols: ['buildLockfile', 'readLockfile', 'compareLockfiles', 'assertNoDrift'],
    },

    // Capability: diff over sealed builds.
    {
      id: 'diff-engine',
      kind: 'exports',
      promise: 'Any two builds can be compared from build data alone, without re-parsing sources.',
      module: './packages/compiler/dist/index.js',
      symbols: ['diffBuilds', 'renderDiff'],
    },

    // Capability: retrieval with provenance.
    {
      id: 'search-provenance',
      kind: 'command',
      promise: 'Every search result carries a complete source locator.',
      command: 'pnpm',
      args: ['acceptance', '-t', 'search-carries-provenance'],
      timeoutMs: 300_000,
    },

    // Capability: the portable archive.
    {
      id: 'archive',
      kind: 'exports',
      promise: 'A build packs into a standard, verifiable ZIP that any tool can open.',
      module: './packages/backend-local/dist/index.js',
      symbols: ['writeArchive', 'readArchive', 'verifyArchive', 'checksumIndex'],
    },

    // The scenarios themselves. A suite that stops running, or a checklist that drifts
    // from it, is exactly the gap that let four defects through the first Phase 1 gate.
    {
      id: 'acceptance-catalogue',
      kind: 'command',
      promise:
        'The scenarios a person runs are executed on every commit, and the checklist is generated from them.',
      command: 'pnpm',
      args: ['acceptance:docs:check'],
      timeoutMs: 300_000,
    },
    {
      id: 'acceptance-checklist',
      kind: 'path',
      promise: 'The manual checklist the working agreement requires exists and is generated.',
      paths: ['docs/testing/acceptance.md', 'tools/acceptance/src/catalogue.ts'],
    },

    // Public contracts the phase adds.
    {
      id: 'public-schemas',
      kind: 'path',
      promise: 'The contracts this phase adds are published as JSON Schema.',
      paths: ['schemas/status.json', 'schemas/build-diff.json', 'schemas/lore-lock.json'],
    },

    // Benchmarks are recorded, and recorded as provisional.
    {
      id: 'benchmarks',
      kind: 'path',
      promise: 'Lifecycle timings are measured and recorded with the machine that produced them.',
      paths: ['benchmarks/phase-1-dev-machine.json', 'scripts/bench.mjs'],
    },

    // The working agreement requires the next phase to be audited before this one closes.
    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what this phase learned, so it does not rest on disproved assumptions.',
      nextEpic: 3,
      // Named for the phase being audited, not the generic word. Epic #3 already carried a
      // dated "Reality check" section written before Phase 1 existed, and the default
      // marker matched it: the criterion passed on a section that was not a forward audit
      // at all. A marker naming the phase cannot be satisfied by an older note.
      marker: 'Phase 2 audit',
    },

    // Documentation is part of the phase, not a follow-up.
    {
      id: 'documentation',
      kind: 'path',
      promise: 'Load-bearing decisions from this phase are documented.',
      paths: [
        'docs/architecture/cli.md',
        'docs/architecture/discovery.md',
        'docs/architecture/build-orchestration.md',
        'docs/architecture/dependencies.md',
        'docs/architecture/testing.md',
        'docs/package-format/README.md',
      ],
    },
  ],
};
