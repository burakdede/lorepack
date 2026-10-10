import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateWrangler } from '../src/services/wrangler.js';

/**
 * Wrangler resolution, issue #580.
 *
 * The first version walked three directories up from its own file. From the bundled CLI that
 * left the package entirely, so deploy could not find Wrangler, and from an npm install it
 * pointed at `node_modules/deploy-cloudflare/node_modules/wrangler`, an unscoped name anyone
 * could register. Resolution now goes through Node's own algorithm for the package named
 * `wrangler`, from the project and from the CLI's install.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'lore-wrangler-'));
  roots.push(root);
  return root;
}

function writePackage(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(directory, 'bin'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'bin', 'wrangler.js'), 'console.log("4.0.0");\n');
}

describe('locating Wrangler', () => {
  it("finds the project's own wrangler dependency through Node resolution", () => {
    const project = temp();
    writePackage(join(project, 'node_modules', 'wrangler'), {
      name: 'wrangler',
      version: '4.0.0',
      bin: { wrangler: './bin/wrangler.js' },
    });

    const located = locateWrangler([project]);

    expect(located?.bin).toBe(
      join(realpathSync(project), 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    );
    expect(located?.version).toBe('4.0.0');
  });

  it('finds wrangler from a parent node_modules, as a project-local or global install lays it out', () => {
    const prefix = temp();
    const cliDirectory = join(prefix, 'node_modules', '@lorepack', 'cli', 'dist');
    mkdirSync(cliDirectory, { recursive: true });
    writePackage(join(prefix, 'node_modules', 'wrangler'), {
      name: 'wrangler',
      version: '4.1.0',
      bin: './bin/wrangler.js',
    });

    expect(locateWrangler([cliDirectory])?.version).toBe('4.1.0');
  });

  it('never uses the unscoped deploy-cloudflare path the old directory walk produced', () => {
    const prefix = temp();
    const cliDirectory = join(prefix, 'node_modules', '@lorepack', 'cli', 'dist');
    mkdirSync(cliDirectory, { recursive: true });
    writePackage(join(prefix, 'node_modules', 'deploy-cloudflare', 'node_modules', 'wrangler'), {
      name: 'wrangler',
      version: '6.6.6',
      bin: { wrangler: './bin/wrangler.js' },
    });

    // Not `toBeNull`: under `pnpm exec`, NODE_PATH legitimately makes the workspace's own
    // wrangler resolvable. What matters is that the decoy is never the one chosen.
    const located = locateWrangler([cliDirectory]);
    expect(located?.version).not.toBe('6.6.6');
    expect(located?.bin ?? '').not.toContain('deploy-cloudflare');
  });

  it('ignores a package that resolves under the name but is not wrangler', () => {
    const project = temp();
    writePackage(join(project, 'node_modules', 'wrangler'), {
      name: 'not-wrangler',
      version: '1.0.0',
      bin: { wrangler: './bin/wrangler.js' },
    });

    expect(locateWrangler([project])).toBeNull();
  });

  it('prefers the first location that has one', () => {
    const project = temp();
    const other = temp();
    writePackage(join(project, 'node_modules', 'wrangler'), {
      name: 'wrangler',
      version: '4.2.0',
      bin: { wrangler: './bin/wrangler.js' },
    });
    writePackage(join(other, 'node_modules', 'wrangler'), {
      name: 'wrangler',
      version: '4.3.0',
      bin: { wrangler: './bin/wrangler.js' },
    });

    expect(locateWrangler([project, other])?.version).toBe('4.2.0');
  });
});
