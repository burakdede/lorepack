import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBundle, SearchResult } from '@lorepack/core/worker';
import { describe, expect, it } from 'vitest';
import {
  addCloudflareTarget,
  addSemanticSearchCapability,
  buildProject,
  callRemoteMcpTool,
  createCloudflareSmokeProject,
  deployCloudflareTarget,
  provisionCloudflareSmokeTarget,
  readRemoteContext,
  rollbackCloudflareTarget,
  teardownCloudflareSmokeTarget,
  waitForRemoteBuild,
} from '../src/cloudflare-smoke.js';
import { missingCloudflareTestingEnv } from '../src/cloudflare-testing.js';

const BINARY = join(import.meta.dirname, '..', '..', '..', 'packages', 'cli', 'dist', 'entry.js');
const UNIQUE_QUERY = 'phase6-rollback-token';
const UNIQUE_FILE = 'docs/phase6-rollback-proof.md';
const RECEIPTS_DIRECTORY = '.lore/receipts';

describe('the credentialed Cloudflare smoke, issue 93', () => {
  it('depends on the built CLI binary', () => {
    expect(existsSync(BINARY), `${BINARY} is missing. Run \`pnpm build\` first.`).toBe(true);
  });

  const missing = missingCloudflareTestingEnv(process.env);
  it.skipIf(missing.length > 0)(
    `deploys, redeploys after an edit, and rolls back remotely (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const project = createCloudflareSmokeProject('Cloudflare Acceptance');
      const buildIds: string[] = [];
      let target: Awaited<ReturnType<typeof provisionCloudflareSmokeTarget>> | undefined;

      try {
        const localBuildId = await buildProject(project);
        buildIds.push(localBuildId);

        target = await provisionCloudflareSmokeTarget(project.projectName);
        await addCloudflareTarget(project, target);

        const deployed = await deployCloudflareTarget(project);
        expect(deployed.buildId).toBe(localBuildId);

        await waitForRemoteBuild(target.endpointBase, localBuildId);

        const context = await readRemoteContext(target.endpointBase, 'rollback');
        expect((context as ContextBundle).buildId).toBe(localBuildId);
        expect(context.selected.length + context.overview.length).toBeGreaterThan(0);

        const firstSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: 'rollback',
            limit: 3,
          },
        );
        expect(firstSearch.structuredContent.buildId).toBe(localBuildId);
        expect(firstSearch.structuredContent.hits.length).toBeGreaterThan(0);
        expect(firstSearch.structuredContent.hits[0]?.locator.relativePath).toBeDefined();

        writeFileSync(
          join(project.root, UNIQUE_FILE),
          `# Phase 6 rollback proof\n\n${UNIQUE_QUERY} appears only in the second deployed build.\n`,
          'utf8',
        );
        const secondBuildId = await buildProject(project);
        buildIds.push(secondBuildId);
        expect(secondBuildId).not.toBe(localBuildId);

        const secondDeploy = await deployCloudflareTarget(project);
        expect(secondDeploy.buildId).toBe(secondBuildId);
        await waitForRemoteBuild(target.endpointBase, secondBuildId);

        const secondContext = await readRemoteContext(target.endpointBase, UNIQUE_QUERY);
        expect(secondContext.buildId).toBe(secondBuildId);
        expect(secondContext.selected.length + secondContext.overview.length).toBeGreaterThan(0);

        const secondSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: UNIQUE_QUERY,
            limit: 3,
          },
        );
        expect(secondSearch.structuredContent.buildId).toBe(secondBuildId);
        expect(secondSearch.structuredContent.hits.length).toBeGreaterThan(0);
        expect(secondSearch.structuredContent.hits[0]?.locator.relativePath).toBe(UNIQUE_FILE);

        const rollback = await rollbackCloudflareTarget(project, localBuildId);
        expect(rollback.buildId).toBe(localBuildId);
        expect(rollback.previousBuildId).toBe(secondBuildId);
        await waitForRemoteBuild(target.endpointBase, localBuildId);

        const rolledBackContext = await readRemoteContext(target.endpointBase, 'rollback');
        expect(rolledBackContext.buildId).toBe(localBuildId);
        expect(
          rolledBackContext.selected.length + rolledBackContext.overview.length,
        ).toBeGreaterThan(0);

        const rolledBackUniqueSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: UNIQUE_QUERY,
            limit: 3,
          },
        );
        expect(rolledBackUniqueSearch.structuredContent.buildId).toBe(localBuildId);
        expect(rolledBackUniqueSearch.structuredContent.hits).toHaveLength(0);

        const rolledBackRollbackSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: 'rollback',
            limit: 3,
          },
        );
        expect(rolledBackRollbackSearch.structuredContent.buildId).toBe(localBuildId);
        expect(rolledBackRollbackSearch.structuredContent.hits.length).toBeGreaterThan(0);
      } finally {
        try {
          if (target !== undefined) {
            await teardownCloudflareSmokeTarget(
              target,
              project.projectName,
              project.root,
              buildIds,
            );
          }
        } finally {
          project.cleanup();
        }
      }
    },
    600_000,
  );

  it.skipIf(missing.length > 0)(
    `refuses a build whose capabilities exceed the Cloudflare target (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const project = createCloudflareSmokeProject('Cloudflare Capability Loss');
      let target: Awaited<ReturnType<typeof provisionCloudflareSmokeTarget>> | undefined;

      try {
        const buildId = await buildProject(project);
        target = await provisionCloudflareSmokeTarget(project.projectName);
        await addCloudflareTarget(project, target);

        addSemanticSearchCapability(project.root, buildId);

        const denied = await project.lore(['deploy', 'cloudflare', '--no-build', '--yes']);
        expect(denied.code).toBe(1);
        expect(denied.stderr).toContain('LORE_E_CAPABILITY_LOSS');
        expect(denied.stderr).toContain('semantic-search');
        expect(denied.stderr).toContain('--allow-capability-loss semantic-search');
        expect(existsSync(join(project.root, RECEIPTS_DIRECTORY))).toBe(false);
      } finally {
        try {
          if (target !== undefined) {
            await teardownCloudflareSmokeTarget(target, project.projectName, project.root, []);
          }
        } finally {
          project.cleanup();
        }
      }
    },
    600_000,
  );
});
