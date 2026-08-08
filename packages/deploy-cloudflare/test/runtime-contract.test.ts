import { type ContractFixture, runRuntimeContract } from '../../../tools/test-support/src/index.ts';
import { createWorkerRuntimeFixture } from './worker-runtime-fixture.js';

runRuntimeContract({
  name: 'Cloudflare Worker runtime fixture',
  create: async (): Promise<ContractFixture> => createWorkerRuntimeFixture(),
});
