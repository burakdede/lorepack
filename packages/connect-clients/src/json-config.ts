import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Editing someone else's configuration file without breaking it.
 *
 * Architecture 24.8 names client-configuration corruption as a real risk, and every rule
 * here exists because of a specific way to cause it:
 *
 * - **Merge, never replace.** The file holds servers a person configured by hand. Writing
 *   our own document over it loses them, and they find out much later.
 * - **Back up first, with a timestamp.** An edit that goes wrong must be undoable by
 *   someone who does not have the original.
 * - **Write to a sibling and rename.** A process interrupted mid-write leaves a truncated
 *   file that the client refuses to start with; rename is atomic on every filesystem this
 *   runs on, so the file is either the old one or the new one.
 * - **Mark what we created.** `disconnect` has to remove exactly our entry, and nothing
 *   else. Without a marker the safe behaviour is to remove nothing, and the useful
 *   behaviour deletes something that was not ours.
 */

/** The marker that makes an entry ours, and removable. */
export const OWNERSHIP_KEY = 'x-lorepack';

export interface OwnedEntry {
  readonly [OWNERSHIP_KEY]: { readonly projectRoot: string; readonly createdAt: string };
}

export function markOwned(
  entry: Record<string, unknown>,
  projectRoot: string,
): Record<string, unknown> {
  return {
    ...entry,
    [OWNERSHIP_KEY]: { projectRoot, createdAt: new Date().toISOString() },
  };
}

export function isOwned(entry: unknown, projectRoot?: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const marker = (entry as Record<string, unknown>)[OWNERSHIP_KEY];
  if (typeof marker !== 'object' || marker === null) return false;
  if (projectRoot === undefined) return true;
  return (marker as { projectRoot?: unknown }).projectRoot === projectRoot;
}

/** Reads a client configuration, tolerating absence but never silently tolerating damage. */
export function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the file is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    // Refused rather than overwritten. A file we cannot parse is one we certainly cannot
    // merge into, and replacing it would destroy whatever the user actually has.
    throw new Error(
      `${path} is not valid JSON, so it will not be edited: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** A timestamped copy beside the original, returned so a receipt can name it. */
export function backup(path: string, now: () => Date = () => new Date()): string | undefined {
  if (!existsSync(path)) return undefined;
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const target = `${path}.lorepack-${stamp}.bak`;
  copyFileSync(path, target);
  return target;
}

/**
 * Writes atomically, so an interrupted run leaves the old file rather than half of one.
 *
 * The temporary file is a sibling deliberately: a rename across filesystems is not atomic,
 * and the OS temp directory is frequently on a different one from a user's home.
 */
export function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/** Sets one server entry inside a nested container, leaving every sibling untouched. */
export function withServerEntry(
  document: Record<string, unknown>,
  containerKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const container = document[containerKey];
  const servers =
    typeof container === 'object' && container !== null && !Array.isArray(container)
      ? (container as Record<string, unknown>)
      : {};
  return { ...document, [containerKey]: { ...servers, [serverName]: entry } };
}

/**
 * Removes one server entry, and only if it is ours.
 *
 * Returns whether anything was removed, so the caller can say "nothing to do" rather than
 * claiming to have disconnected something it left in place.
 */
export function withoutServerEntry(
  document: Record<string, unknown>,
  containerKey: string,
  serverName: string,
  projectRoot?: string,
): { readonly document: Record<string, unknown>; readonly removed: boolean } {
  const container = document[containerKey];
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return { document, removed: false };
  }

  const servers = container as Record<string, unknown>;
  const existing = servers[serverName];
  if (existing === undefined || !isOwned(existing, projectRoot)) {
    // Present but not ours: leaving it is the only defensible choice. A user who configured
    // a server with this name by hand did not ask us to delete it.
    return { document, removed: false };
  }

  const remaining = Object.fromEntries(
    Object.entries(servers).filter(([name]) => name !== serverName),
  );
  return { document: { ...document, [containerKey]: remaining }, removed: true };
}
