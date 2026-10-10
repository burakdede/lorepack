import { type ContractFixture, runRuntimeContract } from '../../../tools/test-support/src/index.ts';
import {
  activateProjectedWorkerRuntimeFixture,
  createProjectedWorkerRuntimeFixture,
} from './projected-runtime-fixture.js';

runRuntimeContract({
  sqlProfile: 'remote',
  name: 'Cloudflare projected SQLite and object ports',
  create: async (): Promise<ContractFixture> => await createProjectedWorkerRuntimeFixture(),
  activateAnother: async (): Promise<string> => await activateProjectedWorkerRuntimeFixture(),
});
