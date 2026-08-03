import type {
  BuildDescription,
  ContextBundle,
  HealthResult,
  SearchRequest,
  SearchResult,
  SourceReadOptions,
  SourceReadResult,
  TableDescription,
  TableQueryResult,
  TaskContextRequest,
} from './contracts.js';

/**
 * A typed client for a Lorepack runtime, with no dependencies at all.
 *
 * `fetch` is standard in Node 24 and in Workers, so this installs anywhere and adds nothing
 * to a consumer's supply chain. That is the whole design brief: an agent author should be
 * able to add Lorepack without inheriting a compiler, a database driver or a schema library.
 *
 * Read-only, because the server is. There is no method here that could build, deploy or
 * edit anything, and no route exists that would answer one.
 */

export interface LoreClientOptions {
  /** Where the runtime is listening, for example `http://127.0.0.1:4321`. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`. Local servers need none; Phase 6 remotes will. */
  readonly token?: string;
  /** Per-request timeout in milliseconds. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Injected for tests and for hosts with their own fetch. Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Attempts for idempotent GETs, including the first. Defaults to 3. */
  readonly retries?: number;
}

/**
 * A failure the server described.
 *
 * The stable `code` is what a caller should branch on. The HTTP status is a courtesy for
 * tools that only speak HTTP, and the remediation is the sentence a human should read.
 */
export class LoreClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly remediation: string | undefined;
  readonly subject: string | undefined;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    remediation?: string | undefined;
    subject?: string | undefined;
  }) {
    super(options.message);
    this.name = 'LoreClientError';
    this.code = options.code;
    this.status = options.status;
    this.remediation = options.remediation;
    this.subject = options.subject;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;

export class LoreClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #retries: number;

  constructor(options: LoreClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Bound, because `fetch` is a method of `Window` in a browser and must be called with
    // that receiver. Storing it and calling `this.#fetch(...)` makes the client the
    // receiver, which a browser rejects with "Illegal invocation" before the request is
    // ever made. Node does not care, which is why every test passed for two phases (#196).
    //
    // An injected implementation is bound to `globalThis` too, which is a no-op for an arrow
    // function or an already-bound function and correct for a plain one.
    const implementation = options.fetch ?? globalThis.fetch;
    this.#fetch = implementation.bind(globalThis);
    this.#retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  }

  health(signal?: AbortSignal): Promise<HealthResult> {
    return this.#get('/health', signal);
  }

  describeBuild(signal?: AbortSignal): Promise<BuildDescription> {
    return this.#get('/v1/build', signal);
  }

  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
    return this.#post('/v1/search', request, signal);
  }

  contextForTask(request: TaskContextRequest, signal?: AbortSignal): Promise<ContextBundle> {
    return this.#post('/v1/context', request, signal);
  }

  readSource(
    artifactId: string,
    options: SourceReadOptions = {},
    signal?: AbortSignal,
  ): Promise<SourceReadResult> {
    const query = new URLSearchParams();
    if (options.lineStart !== undefined) query.set('lineStart', String(options.lineStart));
    if (options.lineEnd !== undefined) query.set('lineEnd', String(options.lineEnd));
    if (options.headingPath !== undefined)
      query.set('headingPath', options.headingPath.join(' > '));
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.#get(`/v1/sources/${encodeURIComponent(artifactId)}${suffix}`, signal);
  }

  listTables(signal?: AbortSignal): Promise<{ tables: Array<{ tableId: string; name: string }> }> {
    return this.#get('/v1/tables', signal);
  }

  describeTable(tableId: string, signal?: AbortSignal): Promise<TableDescription> {
    return this.#get(`/v1/tables/${encodeURIComponent(tableId)}`, signal);
  }

  queryTable(
    tableId: string,
    sql: string,
    options: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<TableQueryResult> {
    return this.#post(
      `/v1/tables/${encodeURIComponent(tableId)}/query`,
      { tableId, sql, ...options },
      signal,
    );
  }

  /**
   * Retried, because a GET here changes nothing and a cold server may not be listening yet.
   * Bounded exponential backoff, and never on a response the server actually produced: a
   * 400 means the request was wrong, and asking again more slowly will not fix it.
   */
  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#retries; attempt += 1) {
      try {
        return await this.#send<T>(path, { method: 'GET' }, signal);
      } catch (error) {
        lastError = error;
        if (error instanceof LoreClientError) throw error;
        if (signal?.aborted === true) throw error;
        if (attempt === this.#retries) break;
        await delay(2 ** (attempt - 1) * 100);
      }
    }
    throw lastError;
  }

  /** Never retried. A POST here can be expensive server-side, and repeating it is rude. */
  async #post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.#send<T>(
      path,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      },
      signal,
    );
  }

  async #send<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    // The caller's signal and the timeout both have to be able to cancel the request, and
    // `AbortSignal.any` is the standard way to say that without leaking a listener.
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      signal: composed,
      headers: {
        Accept: 'application/json',
        ...(this.#token === undefined ? {} : { Authorization: `Bearer ${this.#token}` }),
        ...init.headers,
      },
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      throw new LoreClientError({
        code: 'LORE_E_INTERNAL',
        message: `The server returned a response that is not JSON (HTTP ${response.status}).`,
        status: response.status,
      });
    }

    if (!response.ok) {
      const error = (parsed as { error?: Record<string, unknown> } | null)?.error;
      throw new LoreClientError({
        code: typeof error?.code === 'string' ? error.code : 'LORE_E_INTERNAL',
        message:
          typeof error?.message === 'string'
            ? error.message
            : `The server returned HTTP ${response.status}.`,
        status: response.status,
        ...(typeof error?.remediation === 'string' ? { remediation: error.remediation } : {}),
        ...(typeof error?.subject === 'string' ? { subject: error.subject } : {}),
      });
    }

    return parsed as T;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
