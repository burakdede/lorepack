import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomically } from './config-file.js';

export { backup } from './config-file.js';

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
 * - **Keep its mode, and never follow a link out of the project.** See
 *   [`config-file.ts`](./config-file.ts), which every format shares.
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

/** Writes atomically, keeping the existing file's mode (see `writeFileAtomically`). */
export function writeJsonAtomically(
  path: string,
  value: unknown,
  options: { readonly newFileMode?: number } = {},
): void {
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Where a client keeps its servers: one key (`mcpServers`), or a path to a nested object.
 *
 * Claude Code's local scope is the nested case, `projects[<project>].mcpServers` inside
 * `.claude.json`, beside a great deal of client state that must survive the edit untouched.
 */
export type ContainerPath = string | readonly string[];

const segmentsOf = (path: ContainerPath): readonly string[] =>
  typeof path === 'string' ? [path] : path;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The servers object at `path`, or undefined when any step of the way is missing. */
export function serversAt(
  document: Record<string, unknown>,
  path: ContainerPath,
): Record<string, unknown> | undefined {
  let current: Record<string, unknown> | undefined = document;
  for (const segment of segmentsOf(path)) {
    current = asObject(current?.[segment]);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Replaces the object at `path`, creating each missing step and keeping every sibling. */
function withObjectAt(
  document: Record<string, unknown>,
  path: readonly string[],
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return update(document);
  const child = asObject(document[head]) ?? {};
  return { ...document, [head]: withObjectAt(child, rest, update) };
}

/** Sets one server entry inside a nested container, leaving every sibling untouched. */
export function withServerEntry(
  document: Record<string, unknown>,
  containerPath: ContainerPath,
  serverName: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return withObjectAt(document, segmentsOf(containerPath), (servers) => ({
    ...servers,
    [serverName]: entry,
  }));
}

/**
 * Removes one server entry, and only if it is ours.
 *
 * Returns whether anything was removed, so the caller can say "nothing to do" rather than
 * claiming to have disconnected something it left in place.
 */
export function withoutServerEntry(
  document: Record<string, unknown>,
  containerPath: ContainerPath,
  serverName: string,
  projectRoot?: string,
): { readonly document: Record<string, unknown>; readonly removed: boolean } {
  const servers = serversAt(document, containerPath);
  const existing = servers?.[serverName];
  if (existing === undefined || !isOwned(existing, projectRoot)) {
    // Present but not ours: leaving it is the only defensible choice. A user who configured
    // a server with this name by hand did not ask us to delete it.
    return { document, removed: false };
  }

  const after = withObjectAt(document, segmentsOf(containerPath), (current) =>
    Object.fromEntries(Object.entries(current).filter(([name]) => name !== serverName)),
  );
  return { document: after, removed: true };
}
