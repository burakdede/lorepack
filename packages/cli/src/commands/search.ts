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
        ...(typeof flags.path === 'string' ? { pathGlob: flags.path } : {}),
        ...(typeof flags.type === 'string' ? { type: flags.type } : {}),
      });

      // On stderr, so `--json` stdout stays the structured result alone. A consumer reading
      // JSON sees `sourceState: "unknown"`, which is what the contract's third state means.
      if (freshness.reason !== null) {
        context.warn(`Freshness unknown: ${freshness.reason}\n`);
      }

      return { human: renderSearch(result, query), json: result };
    },
  };
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
