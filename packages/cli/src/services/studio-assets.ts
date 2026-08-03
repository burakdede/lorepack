import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serving Studio's built assets from the package, with no network involved.
 *
 * Architecture 4.3 and 15.1: one process, one port, and the app works with the network
 * disabled. So the assets are files inside the published CLI package, read from disk and
 * handed to the same Hono app that answers `/v1`. There is no CDN, no asset host, and
 * nothing to configure.
 *
 * This lives in the CLI rather than in `@lorepack/runtime` because reading a filesystem is a
 * Node concern and that package also has to compile for a Worker. `createApiApp` takes it as
 * an injected function for exactly that reason.
 */

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Where `vite build` writes, relative to this module once compiled into `dist/`. */
export function studioRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'studio-dist');
}

export function studioIsBuilt(root: string = studioRoot()): boolean {
  return existsSync(join(root, 'index.html'));
}

export type AssetHandler = (request: Request) => Response | null;

/**
 * Reads one file per request, or returns null so the caller's typed 404 still applies.
 *
 * Files are read rather than held in memory: this serves one developer on loopback, the
 * whole bundle is a few hundred kilobytes, and the operating system's page cache is better
 * at this than a hand-rolled map would be.
 */
export function createStudioAssets(root: string = studioRoot()): AssetHandler {
  const index = join(root, 'index.html');

  return (request: Request): Response | null => {
    if (!existsSync(index)) return null;

    const url = new URL(request.url);
    const decoded = safePath(root, url.pathname);

    // Outside the asset root. Not dangerous so much as meaningless, but it is the one thing
    // a static file server must never get wrong, so it is refused rather than clamped.
    if (decoded === null) return null;

    if (decoded !== null && existsSync(decoded) && statSync(decoded).isFile()) {
      return file(decoded);
    }

    // A hash route, so every path that is not a file is the app itself. `/v1` and `/mcp` are
    // registered before this handler and never reach it.
    return file(index);
  };
}

function safePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;
  const candidate = normalize(join(root, decoded));
  // `normalize` resolves `..` first, so this comparison is what actually contains the read.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function file(path: string): Response {
  const body = readFileSync(path);
  const type = MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': type,
      // Vite fingerprints every asset except the entry document, so those are immutable and
      // the document must never be.
      'cache-control': path.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    },
  });
}
