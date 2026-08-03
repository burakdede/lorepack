import { LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { renderSearch, runSearch } from '../services/search.js';
import { readFreshness } from '../services/status.js';

export function searchCommand(): CommandDefinition {
  return {
    name: 'search',
    description: 'Search the active build. Every result carries its source location.',
    arguments: [{ name: 'query', description: 'what to look for' }],
    flags: [
      { flags: '--limit <count>', description: 'results to return (default 10)' },
      { flags: '--path <glob>', description: 'restrict to paths matching a glob' },
      { flags: '--type <extension>', description: 'restrict to one file extension' },
      {
        flags: '--source <artifact>',
        description: 'restrict to one document, by path or artifact id',
      },
      {
        flags: '--include-archived',
        description: 'include archived and superseded sources, which are labelled',
      },
      { flags: '--debug', description: 'show why each result ranked where it did' },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const query = args[0] ?? '';

      // Freshness travels with the answer (section 4.10): a result from a stale build is
      // still a result, but the reader has to be told which build it came from. It is an
      // annotation, never a precondition, so failing to establish it degrades the label
      // rather than the query. See `readFreshness`.
      const freshness = await readFreshness({ config });

      const result = await runSearch({
        config,
        query,
        sourceState: freshness.sourceState,
        limit: parseLimit(flags.limit),
        includeArchived: flags.includeArchived === true,
        debug: flags.debug === true,
        ...(typeof flags.path === 'string' ? { pathGlob: filter('--path', flags.path) } : {}),
        ...(typeof flags.type === 'string' ? { type: filter('--type', flags.type) } : {}),
        ...(typeof flags.source === 'string'
          ? { artifactId: filter('--source', flags.source) }
          : {}),
      });

      // On stderr, so `--json` stdout stays the structured result alone. A consumer reading
      // JSON sees `sourceState: "unknown"`, which is what the contract's third state means.
      if (freshness.reason !== null) {
        context.warn(`Freshness unknown: ${freshness.reason}\n`);
      }

      return {
        human: renderSearch(result, query, context.options.verbose || flags.debug === true),
        json: result,
      };
    },
  };
}

/**
 * A filter has to filter something.
 *
 * An empty value is what an unset shell variable expands to, and passing it through returns
 * "no matches" for a query that would otherwise have answered. That is a wrong answer
 * wearing the clothes of a right one, which is worse than an error. The protocol surfaces
 * already refuse it (`artifactId` is `min(1)`), so refusing here also makes the CLI and the
 * API agree.
 */
function filter(flag: string, value: string): string {
  if (value.trim() !== '') return value;
  throw new LoreError('LORE_E_INVALID_ARGUMENT', `${flag} was given an empty value.`, {
    remediation: `Pass something for ${flag}, or leave the flag off to search everything.`,
    subject: flag,
  });
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `--limit must be between 1 and 100, got ${raw}.`,
      {
        remediation: 'Pass a whole number, for example `--limit 20`.',
      },
    );
  }
  return value;
}
