import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let directory: string;
let results: Record<string, string | null>;

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lorepack-mocker-boundary-')));
  const root = resolve(import.meta.dirname, '../../..');
  const script = `
    import { createRequire } from 'node:module';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const require = createRequire(join(process.argv[1], 'package.json'));
    const tooling = createRequire(require.resolve('vitest/package.json'));
    const { createServer } = await import(pathToFileURL(tooling.resolve('vite')).href);
    const { interceptorPlugin } = await import(pathToFileURL(tooling.resolve('@vitest/mocker/node')).href);
    const fixture = process.argv[2];
    const project = join(fixture, 'project');
    mkdirSync(project);
    writeFileSync(join(fixture, 'outside.js'), 'export const value = "outside-marker";');
    writeFileSync(join(project, '.env'), 'denied-environment-marker');
    writeFileSync(join(project, 'allowed.js'), 'export const value = "allowed-marker";');
    const server = await createServer({ root: project, configFile: false,
      server: { middlewareMode: true, hmr: false, fs: { strict: true, allow: [project], deny: ['**/.env*'] } } });
    try {
      const listeners = new Map();
      server.ws.on = (event, listener) => { listeners.set(event, listener); return server.ws; };
      const plugin = interceptorPlugin();
      plugin.configureServer(server);
      const register = listeners.get('vitest:interceptor:register');
      if (!register) throw new Error('Missing public redirect registration handler.');
      const results = {};
      for (const [name, redirect] of Object.entries({ outside: 'lorepack:../outside.js',
        denied: 'lorepack:.env', allowed: 'lorepack:allowed.js' })) {
        const id = '/virtual/' + name;
        register({ type: 'redirect', raw: id, id, url: id, redirect });
        results[name] = (await plugin.load.handler(id)) ?? null;
      }
      console.log(JSON.stringify(results));
    } finally { await server.close(); }
  `;
  results = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script, root, directory], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('contributor redirect-mock file boundaries', () => {
  it('refuses an opaque URL that escapes the configured project root', () => {
    expect(results.outside).toBeNull();
  });
  it('refuses an in-root file denied by the Vite serving policy', () => {
    expect(results.denied).toBeNull();
  });
  it('retains a permitted redirect to a real source file', () => {
    expect(results.allowed).toBe('export const value = "allowed-marker";');
  });
});
