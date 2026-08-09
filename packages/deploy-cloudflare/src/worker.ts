import { type CloudflareBindings, createCloudflareWorkerFromBindings } from './worker-app.js';

export interface WorkerEnv extends CloudflareBindings {}

/**
 * The Worker module export used by `wrangler dev` and deployment.
 *
 * The runtime is created from bindings on each request, so the public Worker path reads the
 * same D1 and R2 projection the package tests exercise and never depends on local-only
 * injected fixtures.
 */
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> | Response {
    return createCloudflareWorkerFromBindings(env, { authMode: 'runtime-token' }).fetch(request);
  },
};
