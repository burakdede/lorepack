/**
 * Canonical serialization for hashing. Two properties matter:
 *
 * 1. Stable ordering, so key insertion order cannot change a hash.
 * 2. Length prefixes, so concatenation is unambiguous. Without them, ["ab","c"] and
 *    ["a","bc"] would hash identically, and a chunk boundary change could go unnoticed.
 */
export const CANONICALIZATION_VERSION = 1 as const;
export const HASH_ALGORITHM = 'sha256' as const;

export type Canonical =
  | string
  | number
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

export function canonicalize(value: Canonical): string {
  if (value === null) return 'n';
  switch (typeof value) {
    case 'string':
      return `s${value.length}:${value}`;
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'number': {
      if (!Number.isFinite(value)) {
        // A non-finite number has no stable textual form worth hashing.
        return 'x';
      }
      // Integers serialize exactly; anything else is rejected upstream by the schemas.
      const text = Number.isInteger(value) ? String(value) : value.toPrecision(17);
      return `i${text.length}:${text}`;
    }
    default:
      break;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => canonicalize(item as Canonical));
    return `a${parts.length}:${parts.join('')}`;
  }
  const record = value as { readonly [key: string]: Canonical };
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${canonicalize(key)}${canonicalize(record[key] as Canonical)}`);
  return `o${keys.length}:${parts.join('')}`;
}

export async function hashCanonicalPortable(value: Canonical): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
