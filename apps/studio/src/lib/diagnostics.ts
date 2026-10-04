/**
 * `GET /v1/diagnostics`: the doctor report, the running session, and the AI clients.
 *
 * Shared by Diagnostics and the Overview's Connect panel under one query key, so the checks
 * run once however many places read them.
 */
export type Status = 'pass' | 'warn' | 'fail';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly detail: string;
  readonly remediation?: string;
  readonly values?: Record<string, string | number | boolean>;
}

export interface Report {
  readonly doctor: {
    readonly status: Status;
    readonly project: string | null;
    readonly checks: readonly Check[];
    readonly counts: { readonly pass: number; readonly warn: number; readonly fail: number };
  };
  readonly environment: Record<string, string | number | boolean>;
  readonly session: {
    readonly host: string;
    readonly port: number;
    readonly pid: number;
    readonly startedAt: string;
    readonly watcher: {
      readonly state: string;
      readonly watchedPaths: number;
      readonly lastEventAt: string | null;
      readonly lastRebuild: {
        readonly at: string;
        readonly durationMs: number;
        readonly created: boolean;
        readonly failed: boolean;
      } | null;
      readonly rebuilds: number;
      readonly noOps: number;
    } | null;
  };
  readonly clients: readonly {
    readonly id: string;
    readonly title: string;
    readonly installed: boolean;
    readonly version?: string;
    readonly supported: boolean;
    readonly configured: boolean;
    readonly ownedByLorepack: boolean;
    readonly configPath?: string;
    readonly reason?: string;
  }[];
}

export async function fetchDiagnostics({
  signal,
}: {
  readonly signal: AbortSignal;
}): Promise<Report> {
  const response = await fetch('/v1/diagnostics', { signal });
  const parsed = await response.json();
  if (!response.ok) throw parsed;
  return parsed as Report;
}

export type Client = Report['clients'][number];

export function describeConnection(entry: Client): string {
  if (!entry.configured) return 'no';
  // The distinction that makes `lore disconnect` safe is worth showing here too: an entry
  // someone wrote by hand is theirs, and Lorepack says so rather than claiming credit.
  return entry.ownedByLorepack ? 'yes' : 'yes, configured by hand';
}
