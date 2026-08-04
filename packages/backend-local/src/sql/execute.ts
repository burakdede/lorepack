import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoreError } from '@lorepack/core';
import { validateStatement } from './statement.js';

/**
 * Running one model-authored query, with a deadline that is actually enforceable.
 *
 * The parent validates the statement's shape, hands it to a child process, and waits. If the
 * deadline passes, the child is killed with `SIGKILL`.
 *
 * A **process**, not a worker thread, and that was decided by measurement. `worker.terminate()`
 * does not return while the thread is inside a synchronous native SQLite call: a terminate
 * request on such a thread had still not resolved twenty seconds later, because V8 cannot
 * interrupt native code. `SIGKILL` comes from the operating system and is not subject to that,
 * which is what turns section 19.5's deadline from an intention into a guarantee.
 * `adr-sql-surface.md` records the measurement.
 */

export const QUERY_LIMITS = {
  /** Rows returned when the caller does not ask for fewer. */
  defaultRows: 100,
  maxRows: 10_000,
  /** Serialized response bytes. A result nobody can read is not a useful answer. */
  maxBytes: 1_000_000,
  /** Wall clock. Past this the child is killed. */
  deadlineMs: 5_000,
  /** How long the child is given to open the build and report ready. */
  startupMs: 10_000,
} as const;

export interface QueryRequest {
  readonly databasePath: string;
  /** The physical tables this query may read, and nothing else in the build. */
  readonly allowedTables: readonly string[];
  readonly sql: string;
  readonly limit?: number | undefined;
}

export interface QueryOutcome {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

type ChildReply =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; kind: 'too-large'; bytes: number }
  | { ok: false; kind: 'failed'; message: string }
  | { ready: true };

/**
 * The child's entry file, always the **compiled** one.
 *
 * A forked process does not inherit its parent's module loader, so under a TypeScript test
 * runner a `.ts` entry starts and then fails on its own first import. Pointing at `dist/` makes
 * the child identical in tests and in production, which for the highest-risk surface in the
 * product is worth more than the convenience of running it from source: a security control that
 * behaves differently under test is not tested. `pnpm test` builds first.
 */
function childEntry(): string {
  const sibling = fileURLToPath(new URL('./query-child.js', import.meta.url));
  if (existsSync(sibling)) return sibling;

  // From `src/sql/`, the package root is two levels up.
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const compiled = join(packageRoot, 'dist', 'sql', 'query-child.js');
  if (existsSync(compiled)) return compiled;

  throw new LoreError('LORE_E_INTERNAL', 'The query engine is missing from this install.', {
    remediation:
      'Reinstall Lorepack. From a checkout, run `pnpm build` first: the query engine always runs compiled, so that it is the same code under test as in production.',
    subject: compiled,
  });
}

/**
 * One query, one process, always killed.
 *
 * A process per query rather than a pool. A pool would be faster and would also mean a query
 * observing state left by the previous one, which for a surface whose entire purpose is
 * isolation is the wrong trade. Startup is tens of milliseconds against a five-second deadline.
 */
export async function executeQuery(request: QueryRequest): Promise<QueryOutcome> {
  const statement = validateStatement(request.sql);
  const limit = boundedLimit(request.limit);

  const child = fork(childEntry(), [], {
    // Nothing from the parent's environment is inherited, and no stdio is wired through: a
    // query has no business reading configuration or writing to the console.
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.send({ databasePath: request.databasePath, allowedTables: [...request.allowedTables] });

  try {
    return await run(child, statement.sql, limit);
  } finally {
    // `SIGKILL`, and deliberately not awaited. A child running a pathological query will not
    // handle a signal, because it is inside a native call; the kernel stops it regardless.
    // Not awaiting matters just as much: waiting for the exit of a process being killed would
    // reintroduce exactly the hang that ruled out worker threads.
    child.kill('SIGKILL');
    child.unref();
  }
}

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined) return QUERY_LIMITS.defaultRows;
  return Math.max(1, Math.min(requested, QUERY_LIMITS.maxRows));
}

function run(child: ChildProcess, sql: string, limit: number): Promise<QueryOutcome> {
  return new Promise<QueryOutcome>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(startup);
      action();
    };

    const startup = setTimeout(() => {
      finish(() => {
        reject(
          new LoreError('LORE_E_SQLITE_UNAVAILABLE', 'The query engine did not start.', {
            remediation: 'Run `lore doctor` to check this environment.',
          }),
        );
      });
    }, QUERY_LIMITS.startupMs);

    const deadline = setTimeout(() => {
      finish(() => {
        reject(
          new LoreError(
            'LORE_E_LIMIT_EXCEEDED',
            `The query ran longer than ${String(QUERY_LIMITS.deadlineMs / 1000)} seconds and was stopped.`,
            {
              // Actionable rather than apologetic: the three shapes below are what actually
              // cause this, in rough order of how often.
              remediation:
                'Add a LIMIT, narrow the WHERE clause, or check that a recursive CTE has a termination condition. Nothing was changed: this surface only reads.',
            },
          ),
        );
      });
    }, QUERY_LIMITS.deadlineMs);

    child.on('message', (reply: ChildReply) => {
      if ('ready' in reply) {
        clearTimeout(startup);
        child.send({ sql, limit, maxBytes: QUERY_LIMITS.maxBytes });
        return;
      }
      finish(() => {
        if (reply.ok) {
          resolve({ columns: reply.columns, rows: reply.rows, truncated: reply.truncated });
          return;
        }
        reject(reply.kind === 'too-large' ? tooLarge(reply.bytes) : classify(reply.message));
      });
    });

    child.on('error', (cause: Error) => {
      finish(() => {
        reject(classify(cause.message));
      });
    });
    child.on('exit', (code: number | null) => {
      // A child that exits without answering has usually been killed by the operating system,
      // most often for memory. Reported as a limit rather than as an internal error, because
      // that is what it is from the caller's side and it is the caller who can act on it.
      finish(() => {
        reject(
          new LoreError(
            'LORE_E_LIMIT_EXCEEDED',
            `The query stopped unexpectedly (code ${String(code ?? 'signal')}).`,
            {
              remediation: 'Add a LIMIT or narrow the query. The build was not modified.',
            },
          ),
        );
      });
    });
  });
}

function tooLarge(bytes: number): LoreError {
  return new LoreError(
    'LORE_E_LIMIT_EXCEEDED',
    `The result is ${Math.round(bytes / 1024).toLocaleString('en-US')} KB, above the ${String(QUERY_LIMITS.maxBytes / 1_000_000)} MB a single response may carry.`,
    {
      remediation:
        'Select fewer columns, or aggregate. A response larger than this is not something a model can read, so truncating it silently would be worse than saying so.',
    },
  );
}

/**
 * A SQLite error, turned into something a caller can act on and nothing they should not see.
 *
 * "authorization denied" is the authorizer doing its job, and the raw text says nothing about
 * *what* was denied, so it is translated into the rule that was broken. Everything else is
 * passed through as a syntax-level message, which is safe: SQLite's parse errors quote the
 * user's own SQL and never the schema or the filesystem.
 */
function classify(message: string): LoreError {
  // SQLite words a denial as `access to t_secrets_f13bc4051aa0.c_0_sku is prohibited`, which
  // names the physical table and column of something the caller was not allowed to see. That
  // is a disclosure in the error text itself, so the message is replaced rather than wrapped.
  if (/not authorized|authorization denied|is prohibited/i.test(message)) {
    return new LoreError(
      'LORE_E_SQL_REJECTED',
      'The query touches something outside the table it was asked about.',
      {
        remediation:
          'A query may read the table named in the request and call ordinary SQL functions. It cannot read other tables, the build catalog, or anything on this machine. Run `lore inspect tables` to see what a build contains.',
      },
    );
  }
  if (/no such table/i.test(message)) {
    return new LoreError(
      'LORE_E_SQL_REJECTED',
      'The query names a table this build does not expose.',
      {
        remediation:
          'Use `describeTable` first, or `lore inspect tables`, to see the exact table and column names. They are generated, so they are rarely what a source file called them.',
      },
    );
  }
  return new LoreError('LORE_E_SQL_REJECTED', `The query could not be run: ${message}`, {
    remediation: 'Check the SQL. Only a single read-only SELECT is accepted.',
  });
}
