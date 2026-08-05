import { arch, platform, release } from 'node:os';
import { probeFts5 } from '@lorepack/backend-local';
import {
  CLAUDE_CODE_ID,
  type ClientStatus,
  CODEX_ID,
  createClaudeCodeConnector,
  createCodexConnector,
  SERVER_NAME,
} from '@lorepack/connect-clients';
import type { DoctorReport, LoadedConfig } from '@lorepack/core';
import { runDoctor } from './doctor.js';
import { COMPILER_VERSION } from './versions.js';
import type { WatchStatus } from './watch.js';

/**
 * Everything `lore doctor` knows, plus what only a running session can know.
 *
 * The checks are not reimplemented here and never will be. `runDoctor` produces the same
 * report the CLI prints, validated against the same published schema
 * (`schemas/doctor-report.json`), and this composes it with three things a one-shot command
 * cannot see: the live watcher, the process serving the request, and which clients are
 * currently wired to this project.
 *
 * Read-only apart from doctor's own temporary in-memory FTS5 probe. Opening a diagnostics
 * page must never be a side effect, which is also why client status reads configuration files
 * rather than spawning anything.
 */

export interface DiagnosticsInput {
  readonly config: LoadedConfig;
  readonly host: string;
  /** A function, because the port is chosen by binding and is not known before then. */
  readonly port: () => number;
  readonly startedAt: string;
  /** Present when a watcher is running, which is `lore dev` and not `lore serve`. */
  readonly watchStatus?: () => WatchStatus;
}

export function createDiagnosticsEndpoint(input: DiagnosticsInput): () => Promise<unknown> {
  return async () => {
    const doctor: DoctorReport = await runDoctor({
      cwd: input.config.projectRoot,
      port: input.port(),
      // This process is the one holding that port, so "in use" is the expected answer here
      // rather than a warning about someone else's server.
      portHeldByThisProject: true,
    });

    return {
      doctor,
      environment: environment(),
      session: {
        host: input.host,
        port: input.port(),
        pid: process.pid,
        startedAt: input.startedAt,
        watcher: input.watchStatus?.() ?? null,
      },
      clients: await clients(input.config),
    };
  };
}

/**
 * The facts that describe this machine rather than this project.
 *
 * Duplicated in part by individual doctor checks, and deliberately: a check answers "is this
 * a problem", and these answer "what am I running on", which is the first thing anyone pastes
 * into a bug report.
 */
function environment(): Record<string, string | boolean> {
  const probe = probeFts5();
  return {
    node: process.version,
    platform: `${platform()} ${release()}`,
    arch: arch(),
    sqlite: probe.sqliteVersion,
    fts5: probe.available,
    lorepack: COMPILER_VERSION,
  };
}

/**
 * Which AI clients are installed, and whether this project is wired into them.
 *
 * Registration is explicit (architecture 4.8), so this list is the list of connectors that
 * exist, not a discovery. It reports paths and booleans and never the contents of a
 * configuration file, which is what keeps a credential in someone's `.claude.json` off this
 * page (section 15.6).
 */
async function clients(
  config: LoadedConfig,
): Promise<readonly (ClientStatus & { id: string; title: string })[]> {
  const connectors = [createClaudeCodeConnector(), createCodexConnector()];
  const input = {
    projectRoot: config.projectRoot,
    serverName: SERVER_NAME,
    command: {
      executable: 'lore',
      args: ['mcp', '--project', config.projectRoot, '--ensure-current'],
    },
    scope: 'project' as const,
  };

  return Promise.all(
    connectors.map(async (connector) => {
      try {
        return { id: connector.id, title: connector.title, ...(await connector.status(input)) };
      } catch (error) {
        // A client that cannot be inspected is reported as one, because a Diagnostics page
        // that failed entirely because one adapter threw would hide the nine things that
        // were fine.
        return {
          id: connector.id,
          title: connector.title,
          installed: false,
          supported: false,
          configured: false,
          ownedByLorepack: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/** Exported for the tests, which assert the endpoint answers for every registered client. */
export const KNOWN_CLIENT_IDS: readonly string[] = [CLAUDE_CODE_ID, CODEX_ID];
