import { createHash } from 'node:crypto';
import { type Canonical, canonicalize, HASH_ALGORITHM } from './canonical_value.js';

export {
  CANONICALIZATION_VERSION,
  type Canonical,
  canonicalize,
  HASH_ALGORITHM,
} from './canonical_value.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash(HASH_ALGORITHM).update(data).digest('hex');
}

/** Hash of a canonically serialized value. */
export function hashCanonical(value: Canonical): string {
  return sha256Hex(canonicalize(value));
}

/**
 * Root over an ordered list of member hashes. Members are sorted so the root does not
 * depend on the order records happened to be produced in, and the count is included so a
 * dropped member cannot be masked.
 */
export function hashRoot(memberHashes: readonly string[]): string {
  const sorted = [...memberHashes].sort();
  const hash = createHash(HASH_ALGORITHM);
  hash.update(`r${sorted.length}:`);
  for (const member of sorted) hash.update(member);
  return hash.digest('hex');
}

export const EMPTY_ROOT = hashRoot([]);
