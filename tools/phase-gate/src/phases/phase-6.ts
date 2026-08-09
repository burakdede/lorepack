import type { PhaseDefinition } from '../types.js';

/**
 * Phase 6, Cloudflare reference projection. Every criterion mirrors a promise in epic #7.
 *
 * This phase is the first remote runtime, so the gate has to hold two things at once:
 * the Worker must answer the same read surface as local, and the deploy path must prove that
 * an immutable build can be projected, activated, resumed and rolled back without becoming
 * "the live database". The criteria therefore split across runtime parity, projection data,
 * deploy lifecycle, auth, and the acceptance harness that ties them together.
 */
export const PHASE_6: PhaseDefinition = {
  phase: 6,
  title: 'Cloudflare reference projection',
  epic: 7,
  criteria: [
    {
      id: 'issues-closed',
      kind: 'issues',
      promise: 'Every Phase 6 issue is closed.',
      milestone: 'P6 Cloudflare',
      allowOpen: [],
    },

    // #86: the Worker is the same public read surface, with no write routes.
    {
      id: 'worker-surface',
      kind: 'command',
      promise:
        'The Worker serves the shared REST and MCP read surface, keeps the write surface absent by registration, and forwards request cancellation through the mounted MCP route.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--project',
        'runtime',
        'packages/runtime/test/http.test.ts',
        '--project',
        'mcp',
        'packages/mcp/test/http.test.ts',
        '--project',
        'deploy-cloudflare',
        'packages/deploy-cloudflare/test/worker-app.test.ts',
        'packages/deploy-cloudflare/test/target-worker.test.ts',
      ],
      timeoutMs: 600_000,
    },
    {
      id: 'wrangler-dev',
      kind: 'command',
      promise:
        'The real Worker module boots under local Wrangler D1 and R2 emulation and answers the public read routes from projected data.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--project',
        'deploy-cloudflare',
        'packages/deploy-cloudflare/test/wrangler-dev.test.ts',
      ],
      timeoutMs: 900_000,
    },

    // #86 and #87: the projected runtime answers through D1 and R2 with bounded query cost.
    {
      id: 'runtime-contract',
      kind: 'command',
      promise:
        'The D1-backed CatalogStore and TableStore answer the shared runtime contract, including spreadsheet table provenance, candidate invisibility and per-capability D1 query budgets.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--project',
        'deploy-cloudflare',
        'packages/deploy-cloudflare/test/catalog.test.ts',
        'packages/deploy-cloudflare/test/tables.test.ts',
        'packages/deploy-cloudflare/test/runtime-contract.test.ts',
        'packages/deploy-cloudflare/test/query-budget.test.ts',
      ],
      timeoutMs: 900_000,
    },
    {
      id: 'projection-data',
      kind: 'command',
      promise:
        'A sealed build projects deterministically into versioned D1 and R2 data, including manifests, metadata, chunks, FTS rows, tables, archives and projection state, with ranking parity across runtimes.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--project',
        'deploy-cloudflare',
        'packages/deploy-cloudflare/test/migrations.test.ts',
        'packages/deploy-cloudflare/test/project-metadata.test.ts',
        'packages/deploy-cloudflare/test/project-search-data.test.ts',
        'packages/deploy-cloudflare/test/project-table-data.test.ts',
        'packages/deploy-cloudflare/test/project-objects.test.ts',
        'packages/deploy-cloudflare/test/project-archive.test.ts',
        'packages/deploy-cloudflare/test/projection-state.test.ts',
        'packages/deploy-cloudflare/test/r2-keys.test.ts',
        'packages/deploy-cloudflare/test/ranking-parity.test.ts',
        'packages/deploy-cloudflare/test/storage.test.ts',
      ],
      timeoutMs: 900_000,
    },

    // #85, #89, #91, #92: plan, apply, receipts, resume, activation, rollback.
    {
      id: 'deploy-lifecycle',
      kind: 'command',
      promise:
        'Cloudflare targets, plans, applies, receipts, resume, activation and rollback behave as one immutable deploy lifecycle rather than a mutable serving database.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--project',
        'cli',
        'packages/cli/test/target.test.ts',
        'packages/cli/test/deploy-cloudflare.test.ts',
        'packages/cli/test/deploy-command.test.ts',
        'packages/cli/test/deploy.test.ts',
        '--project',
        'deploy-cloudflare',
        'packages/deploy-cloudflare/test/target.test.ts',
      ],
      timeoutMs: 900_000,
    },

    // #90: the public Worker must enforce access, not trust the edge blindly.
    {
      id: 'auth',
      kind: 'command',
      promise:
        'Remote authentication is enforced at the Worker boundary, with invalid or missing credentials rejected without leaking source bodies or bearer material.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--project',
        'deploy-cloudflare',
        'packages/deploy-cloudflare/test/access-auth.test.ts',
        'packages/deploy-cloudflare/test/runtime-auth.test.ts',
      ],
      timeoutMs: 600_000,
    },

    // #93: the real acceptance harness and its visible skip contract.
    {
      id: 'acceptance',
      kind: 'command',
      promise:
        'The Cloudflare acceptance harness is checked in, visibly skips without credentials, and carries the smoke and resume-proof scenarios needed for real-account verification.',
      command: 'pnpm',
      args: [
        'vitest',
        'run',
        '--root',
        'tools/acceptance',
        'test/cloudflare-testing.test.ts',
        'test/cloudflare-smoke.test.ts',
      ],
      timeoutMs: 900_000,
    },
    {
      id: 'documentation',
      kind: 'path',
      promise:
        'The stateless Worker decision, deploy projection shape, setup path, query-budget notes and Cloudflare testing contract are written down beside the code they verify.',
      paths: [
        'docs/architecture/adr-cloudflare-worker-stateless.md',
        'docs/architecture/deployment.md',
        'docs/architecture/serving.md',
        'docs/integrations/cloudflare-target-setup.md',
        'docs/integrations/cloudflare-testing.md',
        'packages/deploy-cloudflare/wrangler.jsonc',
      ],
    },

    {
      id: 'forward-audit',
      kind: 'audit',
      promise:
        'The next phase was audited against what Phase 6 learned, so Phase 7 does not rest on disproved Cloudflare assumptions.',
      nextEpic: 8,
      marker: 'Phase 7 audit',
    },
  ],
};
