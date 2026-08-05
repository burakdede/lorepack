import type { PhaseDefinition } from '../types.js';

/**
 * Phase 5, mixed artifacts, tables and rules. Every criterion mirrors a promise in epic #6.
 *
 * Written to the shape #132 established, and shaped by what this phase found rather than only
 * by what its tickets asked for. Five of its criteria exist because of defects discovered
 * *inside* the phase, each by driving the real product rather than by reading code:
 *
 * - `build-identity` exists because five of the seven parsers were absent from the build id,
 *   so bumping a parser's version changed nothing (#234).
 * - `table-description` exists because the description dropped the provenance and statistics it
 *   promised, and revealed none of the names a query needs (#235).
 * - `citation-coordinates` exists because a PDF was cited at a line number it does not have
 *   (#241).
 * - `envelope-excludes` exists because a scale limit failed the whole build rather than the one
 *   table it applied to (#242).
 * - `security-boundary` exists because every control had a unit test and none proved the
 *   control was *reached* by a real request.
 *
 * The pattern under three of those is one thing: a parser recording provenance faithfully, a
 * store with no column for it, and a locator naming a file rather than a place. The contract
 * criterion is the one that generalises it, because the shared suite is what Phase 6's D1
 * backend inherits.
 */
export const PHASE_5: PhaseDefinition = {
  phase: 5,
  title: 'Mixed artifacts, tables and rules',
  epic: 6,
  criteria: [
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 5 issue is closed.',
      milestone: 'P5 Mixed Artifacts',
      // #245 is a Phase 7 release gate measured here, not work this phase owes.
      allowOpen: [245],
    },

    // The parsers (#71, #72, #73, #74, #75), held to one standard.
    {
      id: 'parsers',
      kind: 'command',
      promise:
        'Every supported format is read into structure rather than flattened into prose, and what is deliberately dropped is written down.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'parsers'],
      timeoutMs: 600_000,
    },
    {
      id: 'parser-decision',
      kind: 'path',
      promise:
        'Reading XLSX without a library is a recorded decision with measurements behind it, not a preference.',
      paths: ['docs/architecture/adr-xlsx-parser.md'],
    },

    // Tables and the SQL surface (#76, #77).
    {
      id: 'table-catalog',
      kind: 'command',
      promise:
        'A spreadsheet becomes a typed table with generated identifiers, so no name from a user file ever reaches SQL.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'backend-local', 'tables'],
      timeoutMs: 300_000,
    },
    {
      id: 'sql-surface',
      kind: 'command',
      promise:
        'One read-only SELECT over one table, behind a validator, a per-query authorizer and a deadline that is enforced by killing a process.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'backend-local', 'sql-surface'],
      timeoutMs: 300_000,
    },
    {
      id: 'sql-decision',
      kind: 'path',
      promise:
        'How user SQL is bounded is a recorded decision, including the measurement that ruled out a worker thread.',
      paths: ['docs/architecture/adr-sql-surface.md'],
    },

    /**
     * #235. A description that cannot be turned into a working query is not a description of a
     * queryable table, and the capability shipped unreachable through any documented output.
     */
    {
      id: 'table-description',
      kind: 'command',
      promise:
        'A table description carries its sheet, its cell range, its statistics and the generated names a query must use, so it is sufficient on its own.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'table-description'],
      timeoutMs: 300_000,
    },

    /**
     * The shared suite, which is the one that generalises. Phase 6's D1 backend runs this same
     * file, so a projection cannot rediscover the defects this phase found.
     */
    {
      id: 'runtime-contract',
      kind: 'command',
      promise:
        'Every runtime implementation answers identically about a typed table, including that its locator matches whichever way it is asked.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'runtime-contract'],
      timeoutMs: 300_000,
    },

    /** #241. An invented coordinate is worse than a missing one, because it looks checkable. */
    {
      id: 'citation-coordinates',
      kind: 'command',
      promise:
        'A citation names the coordinate its format actually has: a page for a PDF, a line range for text, and never one it does not have.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'page-locator'],
      timeoutMs: 300_000,
    },

    // Rules (#78, #79), and the invariant that outranks them.
    {
      id: 'rules',
      kind: 'command',
      promise:
        'Declared rules resolve deterministically and reach every interface, and no interface ever claims a conflict was detected.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'rule-semantics'],
      timeoutMs: 300_000,
    },
    {
      id: 'no-conflict-claims',
      kind: 'command',
      promise:
        'Invariant 6, enforced repository-wide rather than per interface: authority is a declared hint, never a finding.',
      command: 'pnpm',
      args: ['check:no-conflict-claims'],
      timeoutMs: 120_000,
    },

    // The connectors (#59, #80, #81), all three held to one contract.
    {
      id: 'connectors',
      kind: 'command',
      promise:
        'Claude Code, Codex and VS Code are each planned, applied to a real configuration surface, verified, and removed, with nothing hand-edited.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'connect-clients'],
      timeoutMs: 300_000,
    },

    /** #234. Different compilation inputs producing one build id is invariant 3 inverted. */
    {
      id: 'build-identity',
      kind: 'command',
      promise:
        "Every registered parser's version reaches the build id, so bumping one invalidates the artifacts it produced.",
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'parser-versions'],
      timeoutMs: 300_000,
    },

    /** #242. One over-wide spreadsheet must not cost a project its build. */
    {
      id: 'envelope-excludes',
      kind: 'command',
      promise:
        'A scale limit excludes the artifact it applies to and keeps the build, saying which file and which limit, and a parser keeps the error code it chose.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'async-parser'],
      timeoutMs: 300_000,
    },

    /**
     * A validator nobody calls passes every test it has, so this is the assembled boundary
     * rather than the controls behind it.
     */
    {
      id: 'security-boundary',
      kind: 'command',
      promise:
        'Hostile input reaching the real API is refused by the rule that covers it, and no response discloses anything about this machine.',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'cli', 'security.e2e'],
      timeoutMs: 600_000,
    },
    {
      id: 'security-map',
      kind: 'path',
      promise:
        'Every security surface names the test that holds it, and says what is deliberately not covered.',
      paths: ['docs/architecture/security.md'],
    },

    /** Milestone 2's exit criterion (#83), over a folder of every supported format. */
    {
      id: 'mixed-acceptance',
      kind: 'command',
      promise:
        'A real mixed folder produces bounded context with reliable provenance and a queryable spreadsheet, driven end to end against the built binary.',
      command: 'pnpm',
      args: ['vitest', 'run', '--root', 'tools/acceptance', '-t', 'mixed/'],
      timeoutMs: 900_000,
    },

    /**
     * Measured, not enforced. The gates are #101's in Phase 7, and the committed runs are what
     * make that comparison possible at all: one of them is already missed (#245), which is
     * knowledge this phase owes the next rather than a failure it owes itself.
     */
    {
      id: 'envelope-benchmarks',
      kind: 'path',
      promise:
        'The envelope is measured rather than assumed, with the machine recorded beside every number.',
      paths: [
        'benchmarks/envelope/reference-2026-08-05.json',
        'benchmarks/retrieval/envelope-2026-08-06.json',
        'scripts/bench-envelope.mjs',
      ],
    },

    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what this phase learned, so it does not rest on disproved assumptions.',
      nextEpic: 7,
    },
  ],
};
