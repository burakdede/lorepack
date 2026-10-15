import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBuild } from '../../packages/cli/dist/services/build.js';
import { packBuild } from '../../packages/cli/dist/services/packing.js';
import { loadConfig, ProgressBus } from '../../packages/core/dist/index.js';

if (process.platform === 'win32') {
  throw new Error('Generate this fixture on POSIX; the archive itself is tested on every OS.');
}
const root = mkdtempSync(join(tmpdir(), 'lore-selector-fixture-'));
try {
  writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: demo\nsources: [alpha, beta, omega]\n');
  const inputs = {
    'omega/z.md': '# ID target\n\nID_TARGET_BODY\n',
    'alpha/omega:z.md': '# Path target\n\nPATH_TARGET_BODY\n',
    'beta/z.md': '# Third duplicate\n\nTHIRD_DUPLICATE_BODY\n',
    'alpha/z.md': '# Duplicate path\n\nDUPLICATE_PATH_BODY\n',
    'alpha/omega/z.md': '# Display alias\n\nDISPLAY_ALIAS_BODY\n',
  };
  for (const [path, content] of Object.entries(inputs)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const config = loadConfig({ cwd: root });
  const built = await runBuild({ config, progress: new ProgressBus() });
  const packed = await packBuild(config, {
    out: join(import.meta.dirname, 'source_selector.lorepack'),
  });
  console.log(
    JSON.stringify({
      buildId: built.buildId,
      members: packed.members,
      node: process.version,
      sqlite: process.versions.sqlite,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
