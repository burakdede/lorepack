import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

/**
 * The emulator this phase is built against actually runs (#86).
 *
 * Phase 6 projects a build onto a Worker with D1 and R2 bindings, and every later ticket assumes
 * that can be exercised locally. This is the one test that proves the assumption rather than
 * inheriting it, so a broken environment says so plainly instead of surfacing as a confusing
 * failure inside a projection test.
 *
 * It is deliberately about the *environment* rather than about Lorepack, and it is the reason
 * the emulator is allowed to be a dependency at all: `check:no-native` was narrowed to the
 * published closure for this (#256), so the thing it bought had better be verified.
 */

describe('the Cloudflare emulator', () => {
  it('runs a Worker with a working D1 binding and R2 bucket', async () => {
    const mf = new Miniflare({
      modules: true,
      script: `export default { async fetch(request, env) {
        await env.DB.exec("CREATE TABLE IF NOT EXISTS probe (value TEXT)");
        await env.DB.prepare("INSERT INTO probe (value) VALUES (?)").bind("from-d1").run();
        const row = await env.DB.prepare("SELECT value FROM probe LIMIT 1").first();
        await env.BUCKET.put("probe", "from-r2");
        const object = await env.BUCKET.get("probe");
        return Response.json({ d1: row.value, r2: await object.text() });
      }}`,
      d1Databases: { DB: 'probe-db' },
      r2Buckets: { BUCKET: 'probe-bucket' },
    });

    try {
      const response = await mf.dispatchFetch('http://localhost/');
      // Both bindings in one request: a Worker that starts and cannot reach its storage is not
      // an environment this phase can be built on.
      expect(await response.json()).toEqual({ d1: 'from-d1', r2: 'from-r2' });
    } finally {
      await mf.dispose();
    }
  }, 120_000);

  it('gives each database its own storage, so a candidate cannot leak into the active build', async () => {
    const script = `export default { async fetch(request, env) {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
      const url = new URL(request.url);
      if (url.searchParams.has('write')) {
        await env.DB.prepare("INSERT INTO t (v) VALUES (?)").bind("x").run();
      }
      const row = await env.DB.prepare("SELECT count(*) AS n FROM t").first();
      return Response.json({ n: row.n });
    }}`;

    const one = new Miniflare({ modules: true, script, d1Databases: { DB: 'one' } });
    const two = new Miniflare({ modules: true, script, d1Databases: { DB: 'two' } });
    try {
      await one.dispatchFetch('http://localhost/?write=1');
      expect(await (await one.dispatchFetch('http://localhost/')).json()).toEqual({ n: 1 });
      // The isolation that makes testing a *candidate* projection meaningful rather than
      // incidental: writing one database must be invisible to the other.
      expect(await (await two.dispatchFetch('http://localhost/')).json()).toEqual({ n: 0 });
    } finally {
      await one.dispose();
      await two.dispose();
    }
  }, 120_000);
});
