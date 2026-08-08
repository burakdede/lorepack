import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { hashBytes, objectKey } from './bytes.js';
import { HASH_ALGORITHM } from './canonical.js';

/**
 * Streaming content hash. The scale envelope is 1 GB across 2,500 files, so nothing may
 * read a whole artifact into memory just to fingerprint it.
 */
export async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash(HASH_ALGORITHM);
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

export { hashBytes, objectKey };
