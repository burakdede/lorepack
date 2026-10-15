import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface TempProject {
  /** Randomised absolute path. Building the same tree from two of these is the
   *  "different absolute workspace paths" determinism condition. */
  readonly root: string;
  readonly write: (relativePath: string, contents: string | Uint8Array) => void;
  readonly path: (relativePath: string) => string;
}

export interface TempProjectOptions {
  /** Directory to copy in, typically under `fixtures/`. */
  readonly from?: string;
  /** Inline files, keyed by POSIX-style relative path. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly prefix?: string;
}

/**
 * Materialises a project into a randomised temp directory, runs the callback, and cleans
 * up even when the callback throws. Cleanup is best effort on Windows, where a lingering
 * handle can block removal.
 */
export async function withTempProject<T>(
  options: TempProjectOptions,
  run: (project: TempProject) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), options.prefix ?? 'lorepack-'));
  const project: TempProject = {
    root,
    path: (relativePath) => join(root, ...relativePath.split('/')),
    write: (relativePath, contents) => {
      const full = join(root, ...relativePath.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    },
  };

  if (options.from !== undefined) cpSync(options.from, root, { recursive: true });
  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    project.write(relativePath, contents);
  }

  try {
    return await run(project);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may hold a handle briefly. A leaked temp directory must not fail a test.
    }
  }
}

export function copyCompiledFixture(source: string, target: string): void {
  if (basename(source) !== basename(target)) {
    throw new Error('A compiled fixture must retain its filename and source map annotation.');
  }
  const mapFile = `${source}.map`;
  const map = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, unknown>;
  const sources = map.sources;
  if (
    map.version !== 3 ||
    (map.sourceRoot ?? '') !== '' ||
    'sections' in map ||
    !Array.isArray(sources) ||
    !sources.every((value: unknown): value is string => typeof value === 'string')
  ) {
    throw new Error('Expected a flat compiler source map with an empty source root.');
  }
  const moved = {
    ...map,
    sources: sources.map((value) =>
      relative(dirname(target), fileURLToPath(new URL(value, pathToFileURL(mapFile))))
        .split(sep)
        .join('/'),
    ),
  };
  copyFileSync(source, target);
  writeFileSync(`${target}.map`, JSON.stringify(moved));
}
