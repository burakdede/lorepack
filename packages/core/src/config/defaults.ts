/**
 * Versioned product defaults, as one data structure rather than scattered fallbacks.
 *
 * Two reasons this shape matters. The layered resolver in Phase 3 layers over these
 * rather than reverse-engineering them, and `config show --effective` can enumerate every
 * resolved value only if there is something to enumerate.
 */

export const DEFAULTS_VERSION = 1 as const;

export interface ChunkingDefaults {
  readonly targetTokens: number;
  readonly maximumTokens: number;
  readonly overlapTokens: number;
}

export interface LimitDefaults {
  readonly maxSourceFiles: number;
  readonly maxTotalBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxChunks: number;
  readonly maxTableRows: number;
  readonly maxTableColumns: number;
  readonly maxPdfPages: number;
}

export interface ProductDefaults {
  readonly defaultsVersion: number;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly followSymlinks: boolean;
  readonly strictRules: boolean;
  readonly chunking: ChunkingDefaults;
  readonly limits: LimitDefaults;
  readonly contextProfile: 'agent' | 'coding' | 'chat' | 'deep';
  readonly includeOriginals: boolean;
}

/**
 * Exclusions that always apply, before `.loreignore`. Architecture section 19.2: a
 * guardrail against indexing credentials, not a claim to be a secret scanner.
 */
export const ALWAYS_EXCLUDE: readonly string[] = [
  // Lorepack's own project files. Indexing them would make editing configuration show up
  // as a content change, and they are tooling metadata rather than context.
  'lore.yaml',
  'lore.lock',
  '.loreignore',
  // Version control metadata, for the same reason.
  '.gitignore',
  '.gitattributes',
  '.git/**',
  'node_modules/**',
  '.lore/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '*.p12',
  '*.pfx',
  '.DS_Store',
  'Thumbs.db',
];

/** Files that look like credentials. Warned about at init and discovery, never indexed. */
export const SECRET_SHAPED: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*credentials*.json',
];

export const PRODUCT_DEFAULTS: ProductDefaults = Object.freeze({
  defaultsVersion: DEFAULTS_VERSION,
  include: Object.freeze(['**/*']) as readonly string[],
  exclude: Object.freeze([...ALWAYS_EXCLUDE]) as readonly string[],
  followSymlinks: false,
  strictRules: false,
  chunking: Object.freeze({ targetTokens: 700, maximumTokens: 1200, overlapTokens: 100 }),
  limits: Object.freeze({
    maxSourceFiles: 2500,
    maxTotalBytes: 1024 * 1024 * 1024,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxChunks: 50_000,
    maxTableRows: 500_000,
    maxTableColumns: 100,
    maxPdfPages: 500,
  }),
  contextProfile: 'agent',
  includeOriginals: false,
});
