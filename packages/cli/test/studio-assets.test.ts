import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStudioAssets, studioIsBuilt, studioRoot } from '../src/services/studio-assets.js';

/**
 * Studio's assets as the server hands them out, headers included (#553).
 *
 * Studio activates, rolls back and packs, and it renders untrusted document text, so the
 * document says who may frame it and what may run in it. Without these headers any site
 * could frame it, and a click inside the frame carries a loopback `Origin`.
 */

const THEME = "(() => { document.documentElement.dataset.theme = 'dark'; })();";
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lore-studio-assets-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html><head><script>${THEME}</script><script type="module" src="./assets/app.js"></script></head><body></body></html>`,
    'utf8',
  );
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1);\n', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function get(path: string): Response {
  const response = createStudioAssets(root)(new Request(`http://127.0.0.1:4321${path}`));
  if (response === null) throw new Error(`no asset for ${path}`);
  return response;
}

function directives(policy: string | null): Map<string, string> {
  return new Map(
    (policy ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const [name = '', ...values] = part.split(/\s+/);
        return [name, values.join(' ')] as const;
      }),
  );
}

describe('Studio responses', () => {
  it.each(['/', '/#/versions', '/assets/app.js'])('refuse framing and sniffing on %s', (path) => {
    const response = get(path);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const policy = directives(response.headers.get('Content-Security-Policy'));
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('base-uri')).toBe("'none'");
    expect(policy.get('object-src')).toBe("'none'");
  });

  it('allows the inline theme script by its hash, and no other inline script', () => {
    const policy = directives(get('/').headers.get('Content-Security-Policy'));
    const hash = createHash('sha256').update(THEME, 'utf8').digest('base64');
    expect(policy.get('script-src')).toBe(`'self' 'sha256-${hash}'`);
    expect(policy.get('script-src')).not.toContain('unsafe-inline');
  });

  it('allows the inline script of the real bundle, so the theme runs before first paint', () => {
    const real = studioRoot();
    if (!studioIsBuilt(real)) throw new Error('Run `pnpm build` first: Studio is not built.');
    const html = readFileSync(join(real, 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(inline.length).toBeGreaterThan(0);

    const response = createStudioAssets(real)(new Request('http://127.0.0.1:4321/'));
    const policy = directives(response?.headers.get('Content-Security-Policy') ?? null);
    for (const script of inline) {
      const hash = createHash('sha256')
        .update(script ?? '', 'utf8')
        .digest('base64');
      expect(policy.get('script-src')).toContain(`'sha256-${hash}'`);
    }
  });
});
