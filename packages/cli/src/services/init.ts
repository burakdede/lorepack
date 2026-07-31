import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  ALWAYS_EXCLUDE,
  CONFIG_FILENAME,
  configSchema,
  findProjectRoot,
  IGNORE_FILENAME,
  LORE_DIRECTORY,
  LoreError,
  SECRET_SHAPED,
  toPosix,
  writeFileAtomic,
} from '@lorepack/core';

export const GITIGNORE_FILENAME = '.gitignore' as const;
const GITIGNORE_ENTRY = `${LORE_DIRECTORY}/`;

export interface InitPlan {
  readonly projectRoot: string;
  /** Project-relative POSIX paths this run would create or modify. */
  readonly creates: readonly string[];
  readonly modifies: readonly string[];
  readonly unchanged: readonly string[];
  readonly projectName: string;
  readonly sources: readonly string[];
  readonly secretShaped: readonly string[];
  readonly alreadyInitialized: boolean;
  /**
   * What `--force` would rewrite. Reporting "already initialized" without this leaves the
   * user to guess what the escape hatch does, which is exactly when they reach for it.
   */
  readonly forceWouldChange: readonly string[];
  /** True when the existing config differs from what this run would generate. */
  readonly configDiffers: boolean;
}

export interface InitResult extends InitPlan {
  readonly written: readonly string[];
}

export interface InitOptions {
  readonly directory: string;
  readonly force?: boolean;
  /** Reports what would change without touching the filesystem. */
  readonly dryRun?: boolean;
}

/** Slugified directory name. Collisions are not this tool's problem in v0.1. */
export function projectNameFrom(directory: string): string {
  const base =
    directory
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? 'project';
  const cleaned = base
    .normalize('NFC')
    .replace(/[^a-zA-Z0-9 ._-]+/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return cleaned === '' ? 'project' : cleaned;
}

export function renderConfig(name: string, sources: readonly string[]): string {
  const lines = ['version: 1', `name: ${name}`, '', 'sources:'];
  for (const source of sources) lines.push(`  - ${source}`);
  return `${lines.join('\n')}\n`;
}

export function renderIgnore(): string {
  return [
    '# Paths Lorepack never reads. Patterns are gitignore-style.',
    '# Everything here is excluded before this file is consulted; it is listed so the',
    '# defaults are visible and can be extended.',
    '',
    ...ALWAYS_EXCLUDE.map((pattern) => `${pattern}`),
    '',
    '# Add your own exclusions below.',
    '',
  ].join('\n');
}

/**
 * Files whose names suggest credentials. Architecture section 19.2 is explicit that this
 * is a guardrail rather than a secret scanner, so contents are never read.
 */
export function findSecretShaped(root: string, limit = 5000): string[] {
  const matchers = SECRET_SHAPED.map(toRegExp);
  const found: string[] = [];
  let visited = 0;

  const walk = (directory: string): void => {
    if (visited > limit) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (visited > limit) return;
      visited += 1;
      if (entry === '.git' || entry === 'node_modules' || entry === LORE_DIRECTORY) continue;
      const full = join(directory, entry);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (matchers.some((matcher) => matcher.test(entry))) {
        found.push(toPosix(relative(root, full).split(sep).join('/')));
      }
    }
  };

  walk(root);
  return found.sort();
}

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function gitignoreNeedsEntry(path: string): boolean {
  if (!existsSync(path)) return true;
  const contents = readFileSync(path, 'utf8');
  return !contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === GITIGNORE_ENTRY || line === LORE_DIRECTORY);
}

/** Preserves the file's existing line ending style rather than imposing one. */
function appendGitignoreEntry(path: string): string {
  if (!existsSync(path)) {
    return `# Lorepack build state. Commit lore.yaml, lore.lock and .loreignore instead.\n${GITIGNORE_ENTRY}\n`;
  }
  const contents = readFileSync(path, 'utf8');
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const separator = contents.length === 0 || contents.endsWith(newline) ? '' : newline;
  return `${contents}${separator}${newline}# Lorepack build state${newline}${GITIGNORE_ENTRY}${newline}`;
}

export function planInit(options: InitOptions): InitPlan {
  const root = options.directory;

  if (!existsSync(root)) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `${toPosix(root)} does not exist.`, {
      remediation: 'Create the directory first, or point `lore init` at an existing one.',
    });
  }
  if (!statSync(root).isDirectory()) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `${toPosix(root)} is not a directory.`, {
      remediation: 'Point `lore init` at a directory containing your documents.',
    });
  }

  const configPath = join(root, CONFIG_FILENAME);
  const ignorePath = join(root, IGNORE_FILENAME);
  const gitignorePath = join(root, GITIGNORE_FILENAME);

  const creates: string[] = [];
  const modifies: string[] = [];
  const unchanged: string[] = [];

  const configExists = existsSync(configPath);
  if (!configExists) creates.push(CONFIG_FILENAME);
  else if (options.force === true) modifies.push(CONFIG_FILENAME);
  else unchanged.push(CONFIG_FILENAME);

  if (!existsSync(ignorePath)) creates.push(IGNORE_FILENAME);
  else if (options.force === true) modifies.push(IGNORE_FILENAME);
  else unchanged.push(IGNORE_FILENAME);

  if (gitignoreNeedsEntry(gitignorePath)) {
    if (existsSync(gitignorePath)) modifies.push(GITIGNORE_FILENAME);
    else creates.push(GITIGNORE_FILENAME);
  } else {
    unchanged.push(GITIGNORE_FILENAME);
  }

  // An existing config keeps its name, so re-running never silently renames a project.
  const projectName =
    configExists && options.force !== true ? existingName(configPath, root) : projectNameFrom(root);

  const generated = renderConfig(projectNameFrom(root), ['.']);
  const configDiffers = configExists && safeRead(configPath) !== generated;

  const forceWouldChange =
    configExists && options.force !== true
      ? [CONFIG_FILENAME, IGNORE_FILENAME].filter((name) => existsSync(join(root, name)))
      : [];

  return {
    forceWouldChange,
    configDiffers,
    projectRoot: root,
    creates,
    modifies,
    unchanged,
    projectName,
    sources: ['.'],
    secretShaped: findSecretShaped(root),
    alreadyInitialized: configExists,
  };
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function existingName(configPath: string, root: string): string {
  try {
    const parsed = configSchema.partial().safeParse(
      Object.fromEntries(
        readFileSync(configPath, 'utf8')
          .split(/\r?\n/)
          .flatMap((line) => {
            const match = /^name:\s*(.+)$/.exec(line.trim());
            return match?.[1] === undefined ? [] : [['name', match[1].trim()]];
          }),
      ),
    );
    if (parsed.success && typeof parsed.data.name === 'string') return parsed.data.name;
  } catch {
    // Fall through: a config we cannot read is reported by loadConfig, not here.
  }
  return projectNameFrom(root);
}

/**
 * Writes the project files. Grouped so a failure leaves nothing half-created: content is
 * prepared first, and only then written, each one atomically.
 */
export function runInit(options: InitOptions): InitResult {
  const plan = planInit(options);
  if (options.dryRun === true) return { ...plan, written: [] };

  const root = plan.projectRoot;
  const pending: Array<{ relativePath: string; path: string; contents: string }> = [];

  const wants = (name: string): boolean =>
    plan.creates.includes(name) || plan.modifies.includes(name);

  if (wants(CONFIG_FILENAME)) {
    pending.push({
      relativePath: CONFIG_FILENAME,
      path: join(root, CONFIG_FILENAME),
      contents: renderConfig(plan.projectName, plan.sources),
    });
  }
  if (wants(IGNORE_FILENAME)) {
    pending.push({
      relativePath: IGNORE_FILENAME,
      path: join(root, IGNORE_FILENAME),
      contents: renderIgnore(),
    });
  }
  if (wants(GITIGNORE_FILENAME)) {
    pending.push({
      relativePath: GITIGNORE_FILENAME,
      path: join(root, GITIGNORE_FILENAME),
      contents: appendGitignoreEntry(join(root, GITIGNORE_FILENAME)),
    });
  }

  const written: string[] = [];
  for (const file of pending) {
    writeFileAtomic(file.path, file.contents);
    written.push(file.relativePath);
  }

  return { ...plan, written };
}

/** Guards against initializing inside an existing project by accident. */
export function enclosingProject(directory: string): string | null {
  const found = findProjectRoot(directory);
  return found === null || found === directory ? null : found;
}
