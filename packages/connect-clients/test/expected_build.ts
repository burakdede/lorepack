import { createLocalRuntimeBackend } from '../../backend-local/src/index.js';
import { createRuntime } from '../../runtime/src/index.js';

export async function readExpectedSource(root: string) {
  const backend = createLocalRuntimeBackend({ projectRoot: root });
  try {
    const runtime = createRuntime(backend);
    const { buildId } = await runtime.describeBuild({});
    const listed = await runtime.listSources({ buildId, limit: 1 });
    const artifact = listed.artifacts[0];
    if (artifact === undefined)
      throw new Error('No source is available. Add a supported document and run lorepack build.');
    const request = { buildId, artifactId: artifact.artifactId };
    return { buildId, request, source: await runtime.readSource(request) };
  } finally {
    backend.close();
  }
}
