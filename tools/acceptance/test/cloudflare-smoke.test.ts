import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBundle, SearchResult } from '@lorepack/core/worker';
import { describe, expect, it } from 'vitest';
import {
  addCloudflareTarget,
  buildProject,
  callRemoteMcpTool,
  createCloudflareSmokeProject,
  deployCloudflareTarget,
  provisionCloudflareSmokeTarget,
  readRemoteContext,
  teardownCloudflareSmokeTarget,
  waitForRemoteBuild,
} from '../src/cloudflare-smoke.js';
import { missingCloudflareTestingEnv } from '../src/cloudflare-testing.js';

const BINARY = join(import.meta.dirname, '..', '..', '..', 'packages', 'cli', 'dist', 'entry.js');

describe('the credentialed Cloudflare smoke, issue 93', () => {
  it('depends on the built CLI binary', () => {
    expect(existsSync(BINARY), `${BINARY} is missing. Run \`pnpm build\` first.`).toBe(true);
  });

  const missing = missingCloudflareTestingEnv(process.env);
  it.skipIf(missing.length > 0)(
    `deploys one local build and verifies REST and MCP read it remotely (missing: ${missing.join(', ') || 'none'})`,
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

        const search = await callRemoteMcpTool<SearchResult>(target.endpointBase, 'lore_search', {
          query: 'rollback',
          limit: 3,
        });
        expect(search.structuredContent.buildId).toBe(localBuildId);
        expect(search.structuredContent.hits.length).toBeGreaterThan(0);
        expect(search.structuredContent.hits[0]?.locator.relativePath).toBeDefined();
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
});
