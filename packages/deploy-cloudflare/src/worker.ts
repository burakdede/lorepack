import {
  type CloudflareBindings,
  createCloudflareWorkerFromBindings,
  tableQueryCaller,
} from './worker-app.js';

export interface WorkerEnv extends CloudflareBindings {}

/**
 * The Worker module export used by `wrangler dev` and deployment.
 *
 * The runtime is created from bindings on each request, so the public Worker path reads the
 * same D1 and R2 projection the package tests exercise and never depends on local-only
 * injected fixtures. Building it per request is also what lets the table query rate limit be
 * keyed on this request's caller.
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return await createCloudflareWorkerFromBindings(env, {
      authMode: 'runtime-token',
      tableQueryCaller: await tableQueryCaller(request),
    }).fetch(request);
  },
};
