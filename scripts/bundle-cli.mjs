import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'packages', 'cli');
const dist = join(cli, 'dist');
const entry = join(dist, 'entry.js');
const publicEntry = join(dist, 'public-entry.js');
const index = join(dist, 'index.js');
const publicIndex = join(dist, 'public-index.js');
const sourceMigrations = join(root, 'packages', 'backend-local', 'migrations');
const targetMigrations = join(cli, 'dist', 'migrations');
const externalDependencies = [
  '@hono/*',
  '@modelcontextprotocol/*',
  'chokidar',
  'commander',
  'csv-parse',
  'hono',
  'jose',
  'jsonc-parser',
  'mammoth',
  'mdast-util-from-markdown',
  'pdfjs-dist',
  'rehype-parse',
  'remark-frontmatter',
  'remark-gfm',
  'remark-parse',
  'sax',
  'smol-toml',
  'unified',
  'yaml',
  'yauzl',
  'yazl',
];

if (!existsSync(entry)) {
  throw new Error('CLI TypeScript output is missing. Run tsc -b before bundling.');
}

for (const [entryPoint, outfile] of [
  [entry, publicEntry],
  [index, publicIndex],
]) {
  await build({
    bundle: true,
    entryPoints: [entryPoint],
    external: externalDependencies,
    format: 'esm',
    outfile,
    platform: 'node',
    sourcemap: true,
    target: 'node24',
  });
}

mkdirSync(dirname(targetMigrations), { recursive: true });
rmSync(targetMigrations, { recursive: true, force: true });
cpSync(sourceMigrations, targetMigrations, { recursive: true });

console.log('bundled @lorepack/cli with its internal workspace packages');
