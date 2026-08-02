import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Builds the package layout a user actually receives, so a scenario can run against it.
 *
 * The defect this exists for (#164) was invisible to 761 tests and 34 scenarios because
 * every one of them ran from the working tree, where a file the package does not publish is
 * still sitting on disk. The only way to see it is to assemble a tree that contains exactly
 * what `files` ships and nothing else, then run the binary from there.
 *
 * Each `@lorepack/*` package is **copied**, limited to its declared `files` plus its
 * package.json, which is what `npm pack` would include. Third-party dependencies are
 * **linked** to the ones the workspace already installed: they are not what is under test,
 * copying them would mean re-implementing dependency resolution, and a link resolves its own
 * dependencies from the store exactly as an install does.
 */

export interface StagedInstall {
  /** Absolute path to the staged `lore` entry point. */
  readonly binary: string;
  readonly root: string;
}

export function stageInstall(repoRoot: string, destination: string): StagedInstall {
  const modules = join(destination, 'node_modules');
  mkdirSync(join(modules, '@lorepack'), { recursive: true });

  const packagesDirectory = join(repoRoot, 'packages');
  const externals = new Map<string, string>();

  for (const name of readPackageNames(packagesDirectory)) {
    const source = join(packagesDirectory, name);
    const manifest = readManifest(join(source, 'package.json'));
    if (!manifest.name.startsWith('@lorepack/')) continue;

    const target = join(modules, manifest.name);
    mkdirSync(target, { recursive: true });
    cpSync(join(source, 'package.json'), join(target, 'package.json'));

    for (const entry of manifest.files) {
      // Plain paths only. A glob here would mean this staging quietly diverges from what npm
      // ships, which is the same class of blindness the scenario exists to remove.
      if (/[*?[\]{}]/.test(entry)) {
        throw new Error(
          `${manifest.name} declares the glob "${entry}" in files. ` +
            'This staging copies plain paths only, so it would not match npm. Extend it or drop the glob.',
        );
      }
      const from = join(source, entry);
      if (!existsSync(from)) {
        throw new Error(
          `${manifest.name} declares "${entry}" in files, and it does not exist. Run \`pnpm build\` first.`,
        );
      }
      cpSync(from, join(target, entry), { recursive: true });
    }

    for (const [dependency, range] of Object.entries(manifest.dependencies)) {
      if (range.startsWith('workspace:')) continue;
      const installed = join(source, 'node_modules', dependency);
      if (!existsSync(installed)) {
        throw new Error(
          `${manifest.name} depends on ${dependency}, which is not installed at ${installed}. Run \`pnpm install\`.`,
        );
      }
      externals.set(dependency, installed);
    }
  }

  for (const [dependency, installed] of externals) {
    const target = join(modules, dependency);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    // `junction` on Windows: a directory symlink there needs a privilege that CI does not
    // have, and a junction does not.
    symlinkSync(installed, target, process.platform === 'win32' ? 'junction' : 'dir');
  }

  return { binary: join(modules, '@lorepack', 'cli', 'dist', 'entry.js'), root: destination };
}

interface Manifest {
  readonly name: string;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

function readManifest(path: string): Manifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    name?: string;
    files?: string[];
    dependencies?: Record<string, string>;
  };
  return {
    name: parsed.name ?? '',
    files: parsed.files ?? [],
    dependencies: parsed.dependencies ?? {},
  };
}

function readPackageNames(packagesDirectory: string): readonly string[] {
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
