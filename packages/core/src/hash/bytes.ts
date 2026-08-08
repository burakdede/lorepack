import { createHash } from 'node:crypto';
import { HASH_ALGORITHM } from './canonical.js';

export function hashBytes(data: Uint8Array | string): string {
  return createHash(HASH_ALGORITHM).update(data).digest('hex');
}

/** Content-addressed object key: two levels of fan-out keeps directories manageable. */
export function objectKey(hash: string): string {
  return `sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
}
