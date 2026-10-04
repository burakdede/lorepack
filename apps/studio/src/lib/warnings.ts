/**
 * `GET /v1/warnings`, the one shape cached under `['warnings']`.
 *
 * Overview and Sources both read it and once each cached their own transformation under the
 * same key, so whichever route loaded first decided what the other received (#401). The
 * cache now holds the response as the server sent it, and each route derives its view with
 * `select`, which runs per observer and never writes back to the cache.
 */

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface WarningGroup {
  readonly class: string;
  readonly count: number;
  readonly warnings: readonly Warning[];
}

/** What one ignore rule removed, grouped by the rule rather than listed per file. */
export interface Exclusion {
  readonly pattern: string;
  readonly source: string;
  readonly count: number;
  readonly sample: readonly string[];
}

export interface WarningsReport {
  readonly total: number;
  readonly groups: readonly WarningGroup[];
  /** Null for a build that predates the record of what ignore rules removed. */
  readonly exclusions: readonly Exclusion[] | null;
  readonly excludedByRule: number | null;
}

export const WARNINGS_KEY = ['warnings'] as const;

export async function fetchWarnings({
  signal,
}: {
  readonly signal: AbortSignal;
}): Promise<WarningsReport> {
  const response = await fetch('/v1/warnings', { signal });
  if (!response.ok) throw new Error('Warnings are not available from this server.');
  return (await response.json()) as WarningsReport;
}
