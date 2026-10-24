import { spawnSync } from 'node:child_process';

const ROOT_DOCS = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
]);

function isDocumentationPath(path) {
  return (
    path.startsWith('docs/') ||
    ROOT_DOCS.has(path) ||
    path.startsWith('.changeset/') ||
    path.startsWith('.github/ISSUE_TEMPLATE/') ||
    path === '.github/PULL_REQUEST_TEMPLATE.md' ||
    /^(?:packages|tools)\/[^/]+\/README\.md$/.test(path)
  );
}

export function docsOnly(paths) {
  return paths.length > 0 && paths.every(isDocumentationPath);
}

export function changedPaths(base, head) {
  const result = spawnSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`],
    {
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'git diff failed');
  return result.stdout.split('\0').filter(Boolean);
}

function main(args) {
  if (args.length !== 2 || args.some((value) => value.length === 0)) {
    throw new Error('usage: node scripts/ci-change-scope.mjs <base-sha> <head-sha>');
  }
  const files = changedPaths(args[0], args[1]);
  process.stdout.write(`docs_only=${docsOnly(files)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
