/**
 * Cloudflare R2 key layout for Phase 6.
 *
 * The bucket is target-owned rather than build-owned, so keys must partition by project first.
 * Objects are shared across builds under a content-addressed prefix; archives are build-scoped
 * because rollback and retention address one sealed build at a time.
 */
export function r2ObjectKey(projectId: string, hash: string): string {
  return `${projectId}/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
}

export function r2ArchiveKey(projectId: string, buildId: string): string {
  return `${projectId}/builds/${buildId}/archive.lorepack`;
}
