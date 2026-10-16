import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import type { ConnectionExpectation } from '@lorepack/connect-clients';
import { LORE_DIRECTORY, LoreError, type ProjectConfig } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { readActiveBuild } from './project.js';

export async function readConnectionExpectation(
  config: ProjectConfig,
): Promise<ConnectionExpectation> {
  const active = readActiveBuild(join(config.projectRoot, LORE_DIRECTORY));
  if (active === null) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build.', {
      remediation: 'Run lorepack build before connecting.',
    });
  }
  const backend = createLocalRuntimeBackend({ projectRoot: config.projectRoot });
  try {
    const runtime = createRuntime(backend);
    let offset: number | null = 0;
    do {
      const page = await runtime.listSources({ buildId: active.buildId, limit: 100, offset });
      for (const artifact of page.artifacts) {
        const request = { buildId: active.buildId, artifactId: artifact.artifactId };
        const source = await runtime.readSource(request);
        if (source.text.trim().length > 0) return { buildId: active.buildId, request, source };
      }
      offset = page.nextOffset;
    } while (offset !== null);
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      'The active build contains no readable source.',
      {
        remediation: 'Add a supported document, run lorepack build and reconnect.',
      },
    );
  } finally {
    backend.close();
  }
}
