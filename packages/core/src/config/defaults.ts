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
 * Files that look like credentials. `lorepack init` names any it finds and promises they are
 * never indexed, so this list is spread into `ALWAYS_EXCLUDE` below rather than kept beside
 * it. Two literals drifted once: `*.jks` and `*credentials*.json` were warned about and then
 * built (#585).
 *
 * `.env*` rather than `.env` and `.env.*`: it also covers `.envrc`, which direnv loads and
 * which usually exports the same secrets.
 */
export const SECRET_SHAPED: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*credentials*.json',
];

/**
 * MCP client configuration, which `lorepack connect` itself writes into the project, and the
 * timestamped backups it takes before each edit. These files routinely hold tokens in a
 * server's `env` block, and a default `sources: [.]` would otherwise index them on the next
 * build and serve them to every connected model (#573). Whole directories, because a client
 * keeps more than one file there and none of it is project context.
 */
export const CLIENT_CONFIG: readonly string[] = [
  '.mcp.json',
  '.claude/',
  '.codex/',
  '.cursor/',
  '.vscode/',
  '*.lorepack-*.bak',
];

/**
 * Exclusions that always apply, before `.loreignore`. Architecture section 19.2: a
 * guardrail against indexing credentials, not a claim to be a secret scanner.
 *
 * Directory entries are written with a **trailing slash and no other separator**, which is
 * how gitignore says "a directory of this name, at any depth". Writing them as `foo/**`
 * instead put a separator in the middle, which anchors the rule to the project root, so a
 * `node_modules` or `.git` one level down was indexed like ordinary context (#201). The
 * entries with no slash at all, `.env*` and `.DS_Store`, already matched at any depth, which
 * is why the list looked like it worked.
 *
 * This list is part of `effective.exclude` and therefore of every build id. Changing it moves
 * the id of every project, including one that contains none of the affected files.
 */
export const ALWAYS_EXCLUDE: readonly string[] = [
  // Lorepack's own project files. Indexing them would make editing configuration show up
  // as a content change, and they are tooling metadata rather than context.
  'lore.yaml',
  'lore.lock',
  '.loreignore',
  // Build output. `lorepack pack` writes its archive into the project by default, so without
  // this the tool discovers its own output on the next run and warns about a file it just
  // created (#148). More than noise: an unparseable file becomes a build warning, and
  // warnings are sealed into the build, so an archive lying in the tree changes the bytes
  // of the next archive packed from it. Build identity is unaffected, which is what made
  // this easy to miss.
  '*.lorepack',
  // Version control metadata, for the same reason.
  '.gitignore',
  '.gitattributes',
  '.git/',
  'node_modules/',
  '.lore/',
  'dist/',
  'build/',
  'coverage/',
  ...SECRET_SHAPED,
  ...CLIENT_CONFIG,
  '.DS_Store',
  'Thumbs.db',
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
