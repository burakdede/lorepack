import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closestMatch, type LoadedConfig, RUNTIME_LIMITS } from '@lorepack/core';
import { DEV_PORT } from './dev-session.js';
import { DEFAULT_REVALIDATE_INTERVAL_MS } from './revalidate.js';

/**
 * Every resolved value, with the layer that supplied it and where that layer said it.
 *
 * Architecture 4.9 calls this transparent magic: defaults work, and nothing is hidden. The
 * test of it is whether a user can find out what Lorepack decided without reading the
 * source, which means a value is not enough. A number with no provenance still leaves them
 * asking where it came from and what to edit.
 *
 * ## The distinction that matters most
 *
 * Some of these participate in the **build id** and some do not, and confusing the two is a
 * expensive mistake in both directions. A value that decides what a build *contains*
 * belongs in the hashed effective configuration; a value that decides how a build is
 * *served* does not, and moving one in would change the identity of every build in
 * existence for a number that decides nothing about what any of them hold.
 *
 * The Phase 3 audit on #4 called this out specifically for `RUNTIME_LIMITS`, ports and
 * revalidation intervals. They are shown here, because a user asking "what did you decide"
 * means all of it, and they are marked `buildId: false`.
 */

/** Architecture 6.8, in precedence order, lowest first. */
export const LAYERS = ['defaults', 'project', 'targets', 'environment', 'flags'] as const;
export type Layer = (typeof LAYERS)[number];

export interface ResolvedValue {
  /** Dotted, for example `chunking.targetTokens`. What `config explain` takes. */
  readonly path: string;
  readonly value: unknown;
  readonly layer: Layer;
  /** Where that layer said it: a file path, an environment variable name, or `built-in`. */
  readonly source: string;
  /** Whether changing this changes the build id (architecture 11.4). */
  readonly buildId: boolean;
  /** Redacted everywhere it is rendered. */
  readonly secret?: boolean;
}

export interface ResolvedConfiguration {
  readonly projectRoot: string;
  readonly values: readonly ResolvedValue[];
}

/** `LORE_`-prefixed, and deliberately a short list rather than a general override channel. */
export const ENVIRONMENT_KEYS = [
  'LORE_DEV_PORT',
  'LORE_REVALIDATE_INTERVAL_MS',
  'LORE_LOCK_WAIT_MS',
] as const;

/** Anything whose name looks like a credential is redacted rather than printed. */
const SECRET_PATTERN = /token|secret|password|key|credential/i;

export function resolveConfiguration(
  config: LoadedConfig,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedConfiguration {
  const values: ResolvedValue[] = [];

  const yamlText = existsSync(config.configPath) ? readFileSync(config.configPath, 'utf8') : '';
  const declared = (path: string): boolean => declaredIn(yamlText, path);

  /**
   * Which layer supplied a value, for a key the project file may or may not mention.
   *
   * Only two layers can supply these today: the built-in defaults and `lore.yaml`. The
   * targets layer exists in the precedence order and has no content until Phase 6 adds
   * deployment targets, which #57 says explicitly.
   */
  const fromProjectOrDefaults = (path: string, value: unknown, buildId: boolean): ResolvedValue =>
    declared(path)
      ? { path, value, layer: 'project', source: config.configPath, buildId }
      : { path, value, layer: 'defaults', source: 'built-in', buildId };

  // Everything in the effective configuration participates in the build id, by construction:
  // it *is* the hashed structure (architecture 11.4).
  const effective = config.effective;
  values.push({
    path: 'name',
    value: effective.name,
    layer: 'project',
    source: config.configPath,
    buildId: true,
  });
  values.push(fromProjectOrDefaults('sources', effective.sources, true));
  values.push(fromProjectOrDefaults('include', effective.include, true));
  values.push(fromProjectOrDefaults('exclude', effective.exclude, true));
  values.push(fromProjectOrDefaults('followSymlinks', effective.followSymlinks, true));
  values.push(fromProjectOrDefaults('strictRules', effective.strictRules, true));
  values.push(fromProjectOrDefaults('includeOriginals', effective.includeOriginals, true));
  values.push(fromProjectOrDefaults('contextProfile', effective.contextProfile, true));

  for (const [key, value] of Object.entries(effective.chunking)) {
    values.push(fromProjectOrDefaults(`chunking.${key}`, value, true));
  }
  for (const [key, value] of Object.entries(effective.limits)) {
    values.push(fromProjectOrDefaults(`limits.${key}`, value, true));
  }
  values.push({
    path: 'defaultsVersion',
    value: effective.defaultsVersion,
    layer: 'defaults',
    source: 'built-in',
    buildId: true,
  });
  // Shown even when empty. It is part of the hashed structure whether or not anyone wrote a
  // rule, and a display that claims to be complete cannot omit a value for being boring:
  // "no rules" is exactly what a user checking why ranking looks wrong needs to see.
  values.push({
    path: 'rules',
    value: effective.rules,
    layer: effective.rules.length > 0 ? 'project' : 'defaults',
    source: effective.rules.length > 0 ? config.configPath : 'built-in',
    buildId: true,
  });

  // Serving bounds. Shown, because "what did you decide" means all of it, and marked as not
  // participating, because a serving bound decides nothing about what a build contains.
  for (const [key, value] of Object.entries(RUNTIME_LIMITS)) {
    values.push(withEnvironment(`runtime.${key}`, value, environment, false));
  }
  values.push(withEnvironment('runtime.devPort', DEV_PORT, environment, false));
  values.push(
    withEnvironment(
      'runtime.revalidateIntervalMs',
      DEFAULT_REVALIDATE_INTERVAL_MS,
      environment,
      false,
    ),
  );

  return { projectRoot: config.projectRoot, values: values.sort(byPath) };
}

/** Applies the environment layer to one serving bound, when a `LORE_*` variable names it. */
function withEnvironment(
  path: string,
  fallback: unknown,
  environment: NodeJS.ProcessEnv,
  buildId: boolean,
): ResolvedValue {
  const variable = environmentKeyFor(path);
  const raw = variable === null ? undefined : environment[variable];
  if (variable === null || raw === undefined) {
    return { path, value: fallback, layer: 'defaults', source: 'built-in', buildId };
  }

  const parsed = Number(raw);
  return {
    path,
    value: Number.isFinite(parsed) ? parsed : raw,
    layer: 'environment',
    source: variable,
    buildId,
    ...(SECRET_PATTERN.test(variable) ? { secret: true } : {}),
  };
}

function environmentKeyFor(path: string): string | null {
  if (path === 'runtime.devPort') return 'LORE_DEV_PORT';
  if (path === 'runtime.revalidateIntervalMs') return 'LORE_REVALIDATE_INTERVAL_MS';
  return null;
}

/**
 * Whether `lore.yaml` mentions a key, without reimplementing YAML.
 *
 * A deliberately shallow test: it decides which *layer* to attribute a value to, and it is
 * checked against the parsed configuration for the value itself. Being wrong here shows the
 * wrong provenance, never the wrong number.
 */
function declaredIn(yamlText: string, path: string): boolean {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return false;

  const topLevel = new RegExp(`^${escapeForRegExp(head)}\\s*:`, 'm');
  if (!topLevel.test(yamlText)) return false;
  if (rest.length === 0) return true;

  // A nested key, which in a project file is always indented under its parent.
  const nested = new RegExp(`^\\s+${escapeForRegExp(rest.join('.'))}\\s*:`, 'm');
  return nested.test(yamlText);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function byPath(left: ResolvedValue, right: ResolvedValue): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Redacted for display. Never the value, only the fact that there is one. */
export function displayValue(entry: ResolvedValue): string {
  if (entry.secret === true) return '[redacted]';
  if (Array.isArray(entry.value)) {
    return entry.value.length === 0 ? '(none)' : entry.value.map((item) => String(item)).join(', ');
  }
  if (typeof entry.value === 'object' && entry.value !== null) return JSON.stringify(entry.value);
  return String(entry.value);
}

/**
 * The closest known path to something a user typed.
 *
 * `closestMatch` lives in core because `lore.yaml` validation needs the same answer for an
 * unrecognized key. Two implementations of "what did they probably mean" would give two
 * different answers to the same typo.
 *
 * The threshold scales with the length here, because a configuration path is much longer
 * than a top-level key and a fixed distance of three is nearly meaningless across
 * `chunking.targetTokens`.
 */
export function closestPath(wanted: string, known: readonly string[]): string | null {
  return closestMatch(wanted, known, Math.max(2, Math.floor(wanted.length / 3)));
}

/** Where the targets layer will read from, once Phase 6 gives it something to say. */
export function targetsDirectory(projectRoot: string): string {
  return join(projectRoot, '.lore', 'targets');
}
