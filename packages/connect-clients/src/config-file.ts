import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { LoreError } from '@lorepack/core';

/**
 * Which file a connector may write, and how, before any format-specific code runs.
 *
 * Every connector edits a file that is not ours, and two properties of that file are easy to
 * destroy without noticing (#574):
 *
 * - **Its permissions.** `~/.claude.json` and `~/.codex/config.toml` are 0600 because they
 *   hold API keys and MCP environment tokens. A write-then-rename creates a fresh inode with
 *   the default mode, so a naive atomic write turns a private file world-readable.
 * - **What it is a link to.** A repository can ship `.vscode/mcp.json` as a symlink to
 *   `~/.claude.json`. Following it reads the user's secrets, and renaming over it leaves
 *   them in a regular file inside the project, which the plan then suggests committing.
 *
 * So the rule depends on who owns the location, not on the file format:
 *
 * - A **project** file sits in a directory someone else may have written. Any symlink on the
 *   way to it is refused before anything is read, backed up or written.
 * - A **user** file sits in the user's own home. A symlink there is their dotfile manager,
 *   so the link is resolved and its target is edited in place, next to the target, which
 *   keeps the link and the dotfile repository working.
 */

export type ConfigLocation =
  | { readonly owner: 'project'; readonly projectRoot: string }
  | { readonly owner: 'user' };

/** Mode for a user-scope file this run creates: the same as the clients create them. */
export const PRIVATE_FILE_MODE = 0o600;

/** How a file this run creates should be written: private when it lives in the user's home. */
export function writeOptionsFor(location: ConfigLocation): { readonly newFileMode?: number } {
  return location.owner === 'user' ? { newFileMode: PRIVATE_FILE_MODE } : {};
}

/**
 * The file that will actually be read and written for `path`.
 *
 * Throws for a project file reached through a symlink, so the refusal happens at plan time
 * and `--dry-run` shows it too.
 */
export function resolveConfigFile(path: string, location: ConfigLocation): string {
  if (location.owner === 'project') {
    refuseProjectSymlinks(path, location.projectRoot);
    return path;
  }

  const link = lstatSync(path, { throwIfNoEntry: false });
  if (link === undefined || !link.isSymbolicLink()) return path;
  try {
    return realpathSync(path);
  } catch (cause) {
    throw new LoreError(
      'LORE_E_SOURCE_UNREADABLE',
      `${path} is a symbolic link to a file that does not exist, so it will not be edited.`,
      {
        remediation: 'Restore the file it points at, or remove the link, then run this again.',
        cause,
      },
    );
  }
}

/**
 * Every component from the project root down to the file, checked without following any.
 *
 * Checking only the file itself would leave `.vscode -> ~/.config/Code/User` open, which
 * reaches the same secrets through the directory instead.
 */
function refuseProjectSymlinks(path: string, projectRoot: string): void {
  const segments = relative(projectRoot, path).split(sep).filter(Boolean);
  let current = projectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      const shown = relative(projectRoot, current);
      throw new LoreError(
        'LORE_E_PATH_ESCAPE',
        `${shown} is a symbolic link, so Lorepack will not edit ${relative(projectRoot, path)} through it.`,
        {
          remediation: `A project configuration file must be a regular file inside the project. Replace ${shown} with a real file or directory, or check where it came from before connecting.`,
          path: shown,
        },
      );
    }
  }
}

/**
 * A timestamped copy beside the original, returned so a receipt can name it.
 *
 * Never overwrites: a connect and a disconnect can land in the same millisecond, and the
 * second backup replacing the first would lose the only copy of the original. A taken name,
 * including a link planted at it, moves on to a numbered one instead. The copy keeps the
 * original's mode, which matters because the original may be holding a token.
 */
export function backup(path: string, now: () => Date = () => new Date()): string | undefined {
  if (!existsSync(path)) return undefined;
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; ; attempt += 1) {
    const target = `${path}.lorepack-${stamp}${attempt === 0 ? '' : `-${attempt}`}.bak`;
    try {
      copyFileSync(path, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Writes atomically, so an interrupted run leaves the old file rather than half of one, and
 * the new file carries the old one's permissions.
 *
 * The temporary file is a sibling deliberately: a rename across filesystems is not atomic,
 * and the OS temp directory is frequently on a different one from a user's home. It is
 * created exclusively (no following a planted link) and private, and only given its final
 * mode once its content is complete.
 *
 * `newFileMode` applies only when there is no file yet. Absent, a new file gets the default
 * mode the process would give any file, which is what a project file should have.
 */
export function writeFileAtomically(
  path: string,
  content: string,
  options: { readonly newFileMode?: number } = {},
): void {
  const existing = statSync(path, { throwIfNoEntry: false });
  const mode = existing === undefined ? options.newFileMode : existing.mode & 0o777;

  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode === undefined ? {} : { mode: PRIVATE_FILE_MODE }),
    });
    // Explicit, because the mode given at creation is filtered through the umask and would
    // silently turn 0664 into 0644.
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
