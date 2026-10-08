import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const files = [
  'README.md',
  'PRODUCT.md',
  'DESIGN.md',
  'docs/architecture/studio-design.md',
  'apps/studio/src/App.tsx',
  'apps/studio/index.html',
  'packages/cli/CHANGELOG.md',
];
const forbidden = [/\bLore Studio\b/, /\bLore\s+(?:init|plan|build|dev|connect|search)\b/];
const problems = [];

for (const relative of files) {
  const contents = readFileSync(join(root, relative), 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(contents)) problems.push(`${relative}: ${pattern}`);
  }
}

if (problems.length > 0) {
  console.error(`Public branding check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

console.log(`check:public-branding: ${files.length} public surfaces are current`);
