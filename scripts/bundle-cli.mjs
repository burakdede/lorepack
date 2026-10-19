import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

export async function bundleCli({
  root = resolve(import.meta.dirname, '..'),
  output,
  plugins = [],
  banner,
} = {}) {
  const cli = join(root, 'packages', 'cli');
  const compiled = join(cli, 'dist');
  const dist = output ?? compiled;
  const entry = join(compiled, 'entry.js');
  const index = join(compiled, 'index.js');
  // The table query runs in a forked process, so its entry is a file on disk that the bundle
  // cannot inline. Emitted beside `public-entry.js`, where `childEntry()` in
  // `packages/backend-local/src/sql/execute.ts` looks first (#639).
  const queryChild = join(root, 'packages', 'backend-local', 'dist', 'sql', 'query-child.js');
  // The parse process (#594). `ParserHost` forks `./parse-child.js` relative to its own module,
  // and once bundled its module is `public-entry.js`, so the child has to sit beside it.
  const parseChild = join(root, 'packages', 'parsers', 'dist', 'parse-child.js');
  const residentReader = join(
    root,
    'packages',
    'parsers',
    'dist',
    'linux_resident_reader_worker.js',
  );
  const buildWorker = join(compiled, 'services', 'build_worker.js');
  const verifyBridge = join(root, 'packages', 'connect-clients', 'dist', 'verify_bridge.js');
  const archiveVerifyChild = join(
    root,
    'packages',
    'backend-local',
    'dist',
    'archive-verify-child.js',
  );
  const sourceMigrations = join(root, 'packages', 'backend-local', 'migrations');
  const targetMigrations = join(dist, 'migrations');
  const externalDependencies = [
    '@hono/*',
    '@modelcontextprotocol/*',
    'chokidar',
    'commander',
    'cross-spawn',
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

  for (const compiled of [
    entry,
    queryChild,
    parseChild,
    residentReader,
    archiveVerifyChild,
    buildWorker,
    verifyBridge,
  ]) {
    if (!existsSync(compiled)) {
      throw new Error(`${compiled} is missing. Run tsc -b before bundling.`);
    }
  }

  mkdirSync(dist, { recursive: true });
  for (const filename of readdirSync(dist)) {
    if (/^chunk-[A-Z0-9]{8}\.js(?:\.map)?$/.test(filename)) rmSync(join(dist, filename));
  }
  await build({
    ...(banner ? { banner } : {}),
    plugins,
    bundle: true,
    entryPoints: {
      'public-entry': entry,
      'public-index': index,
      'query-child': queryChild,
      'parse-child': parseChild,
      linux_resident_reader_worker: residentReader,
      'archive-verify-child': archiveVerifyChild,
      build_worker: buildWorker,
      verify_bridge: verifyBridge,
    },
    external: externalDependencies,
    format: 'esm',
    outdir: dist,
    splitting: true,
    chunkNames: 'chunk-[hash]',
    platform: 'node',
    sourcemap: true,
    target: 'node24',
  });

  mkdirSync(dirname(targetMigrations), { recursive: true });
  rmSync(targetMigrations, { recursive: true, force: true });
  cpSync(sourceMigrations, targetMigrations, { recursive: true });
}

if (import.meta.main) {
  await bundleCli();
  console.log('bundled @lorepack/cli with its internal workspace packages');
}
