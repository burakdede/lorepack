import type { PhaseDefinition } from '../types.js';

/**
 * Phase 0, Foundations. Every criterion mirrors a promise in epic #1: its three exit
 * criteria, its stated deliverable, and each row of its capability table.
 *
 * The wording of `promise` is deliberately the phase's own, so a failure reads as a broken
 * guarantee rather than as a broken assertion.
 */
export const PHASE_0: PhaseDefinition = {
  phase: 0,
  title: 'Foundations',
  epic: 1,
  criteria: [
    // Exit criterion 1.
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 0 issue is closed.',
      milestone: 'P0 Foundations',
      allowOpen: [],
    },

    // Exit criterion 2. The Windows and POSIX half comes from the CI matrix running this.
    {
      id: 'determinism',
      kind: 'command',
      promise:
        'Identical canonical inputs produce an identical build id, from two absolute paths and in any enumeration order.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'backend-local', '--project', 'core', '-t', 'determin'],
    },

    // Exit criterion 3.
    {
      id: 'dependency-direction',
      kind: 'command',
      promise:
        'core imports no parser, database, MCP, UI or Cloudflare module, and no package exceeds its allowed edges.',
      command: 'pnpm',
      args: ['test:arch'],
    },

    // The phase's stated deliverable, as a behaviour.
    {
      id: 'exit-criterion-harness',
      kind: 'command',
      promise:
        'A harness can create a build directory, write objects, compute a stable build id, activate a pointer, and roll it back.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'backend-local', '-t', 'Phase 0 exit criterion'],
    },

    // Capability: monorepo, boundaries, engine guard.
    {
      id: 'workspace-layout',
      kind: 'path',
      promise:
        'The workspace matches architecture section 9, with the reserved directories present.',
      paths: [
        'packages/core',
        'packages/parsers',
        'packages/compiler',
        'packages/backend-local',
        'packages/runtime',
        'packages/mcp',
        'packages/cli',
        'packages/connect-clients',
        'packages/deploy-cloudflare',
        'packages/sdk',
        'schemas',
        'migrations/state',
        'migrations/build',
        'fixtures',
        'benchmarks',
        'examples',
        'docs',
      ],
    },
    {
      id: 'engine-guard',
      kind: 'exports',
      promise: 'An unsupported Node runtime fails fast with an actionable message.',
      module: 'packages/core/dist/index.js',
      symbols: ['assertSupportedNode', 'checkNodeVersion', 'SUPPORTED_NODE_RANGE'],
    },

    // Capability: toolchain and the documented command set.
    {
      id: 'command-set',
      kind: 'command',
      promise: 'Everything runs from one documented command set.',
      command: 'pnpm',
      args: ['run', 'verify'],
    },

    // Capability: public schemas.
    {
      id: 'public-schemas',
      kind: 'command',
      promise: 'Committed JSON Schemas match their Zod definitions.',
      command: 'pnpm',
      args: ['schemas:check'],
    },

    // Capability: canonical primitives.
    {
      id: 'canonical-primitives',
      kind: 'exports',
      promise:
        'Canonical paths, identifiers, content hashing, logical hash roots and deterministic build ids exist in core.',
      module: 'packages/core/dist/index.js',
      symbols: [
        'toCanonical',
        'toDisplay',
        'sortCanonical',
        'findCaseCollisions',
        'artifactId',
        'canonicalize',
        'hashRoot',
        'hashFile',
        'hashBytes',
        'deriveBuildId',
        'formatBuildId',
        'resolveBuildIdPrefix',
        'NORMALIZATION_VERSION',
        'CANONICALIZATION_VERSION',
      ],
    },

    // Capability: storage ports and the SQLite adapter.
    {
      id: 'storage-ports',
      kind: 'path',
      promise:
        'Storage ports are declared in core, so runtime depends on behaviour rather than SQLite.',
      paths: ['packages/core/src/ports/storage.ts'],
    },
    {
      id: 'sqlite-adapter',
      kind: 'exports',
      promise:
        'node:sqlite is isolated behind one adapter, with safe open options, an FTS5 probe and a migration runner.',
      module: 'packages/backend-local/dist/index.js',
      symbols: [
        'openReadOnly',
        'openWritable',
        'restrictToTables',
        'assertSqliteApiSurface',
        'integrityCheck',
        'probeFts5',
        'assertFts5Available',
        'loadMigrations',
        'runMigrations',
      ],
    },
    {
      id: 'fts5-available',
      kind: 'command',
      promise: 'The SQLite in use has FTS5, without which lexical search cannot work.',
      command: 'pnpm',
      args: ['probe:fts5'],
    },

    // Capability: object store and atomic build directories.
    {
      // `writeFileAtomic` moved to core during Phase 0, when the architecture rules refused
      // a cli -> backend-local edge for a primitive the compiler and CLI both need. The
      // promise is unchanged; the module that exports it is not, and the criterion below
      // asserts it where it now lives.
      id: 'object-store',
      kind: 'exports',
      promise:
        'Content-addressed objects and atomic build directories exist, so an interrupted build leaves nothing usable behind.',
      module: 'packages/backend-local/dist/index.js',
      symbols: [
        'FileObjectStore',
        'createCandidateDirectory',
        'sealCandidateDirectory',
        'discardCandidateDirectory',
      ],
    },

    // Capability: transactional active pointer.
    {
      id: 'active-pointer',
      kind: 'exports',
      promise:
        'Activation is a transactional pointer change with a monotonic generation, served through reference-counted handles.',
      module: 'packages/backend-local/dist/index.js',
      symbols: ['LocalStateStore', 'LocalActiveBuildProvider', 'ProjectLock'],
    },

    // Capability: error taxonomy and progress.
    {
      id: 'error-taxonomy',
      kind: 'exports',
      promise:
        'Every failure carries a stable code, an exit code and a remediation, rendered per interface with redaction.',
      module: 'packages/core/dist/index.js',
      symbols: [
        'LoreError',
        'ERROR_CODES',
        'EXIT_CODES',
        'exitCodeFor',
        'renderForCli',
        'renderAsJson',
        'renderForProtocol',
        'redact',
      ],
    },
    {
      id: 'progress-reporting',
      kind: 'exports',
      promise:
        'Stages emit measurable progress to subscribing renderers, keeping console code out of the pipeline.',
      module: 'packages/core/dist/index.js',
      symbols: ['ProgressBus', 'ProgressRenderer', 'shouldUseColor'],
    },

    // Capability: guards the working agreement promises.
    {
      id: 'install-guarantees',
      kind: 'command',
      promise: 'No native add-on and no install script can enter the dependency graph.',
      command: 'pnpm',
      args: ['check:no-native'],
    },

    {
      id: 'atomic-writes',
      kind: 'exports',
      promise: 'A file is written atomically or not at all, so a crash cannot leave a torn file.',
      module: 'packages/core/dist/index.js',
      symbols: ['writeFileAtomic', 'fsyncDirectory'],
    },

    // The working agreement requires the next phase to be audited before this one closes.
    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what this phase learned, so it does not rest on disproved assumptions.',
      nextEpic: 2,
    },

    // Documentation is part of the phase, not a follow-up.
    {
      id: 'documentation',
      kind: 'path',
      promise: 'Load-bearing decisions from this phase are documented.',
      paths: [
        'docs/architecture/repo-layout.md',
        'docs/architecture/ci.md',
        'docs/architecture/errors.md',
        'docs/architecture/progress.md',
        'docs/architecture/testing.md',
        'docs/architecture/build-identity.md',
        'docs/architecture/local-storage.md',
        'docs/compatibility/sqlite-fts5.md',
        'docs/package-format/README.md',
      ],
    },
  ],
};
