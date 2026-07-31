import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempProject {
  /** Randomised absolute path. Building the same tree from two of these is the
   *  "different absolute workspace paths" determinism condition. */
  readonly root: string;
  readonly write: (relativePath: string, contents: string) => void;
  readonly path: (relativePath: string) => string;
}

export interface TempProjectOptions {
  /** Directory to copy in, typically under `fixtures/`. */
  readonly from?: string;
  /** Inline files, keyed by POSIX-style relative path. */
  readonly files?: Readonly<Record<string, string>>;
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
