import { verifyHttpReceipt } from './context_receipt.js';
import type {
  BuildDescription,
  ContextBundle,
  ContextReceipt,
  HealthResult,
  SearchRequest,
  SearchResult,
  SourceListRequest,
  SourceListResult,
  SourceReadOptions,
  SourceReadResult,
  TableDescription,
  TableListResult,
  TableQueryResult,
  TaskContextRequest,
} from './contracts.js';

export interface LoreClientOptions {
  readonly buildId?: string;
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
  readonly #buildId: string | undefined;
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #retries: number;

  constructor(options: LoreClientOptions) {
    this.#buildId = options.buildId;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Browser fetch needs Window as its receiver, including injected unbound fetch (#196).
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
    return this.#post(
      '/v1/search',
      { ...request, buildId: request.buildId ?? this.#buildId },
      signal,
    );
  }

  contextForTask(request: TaskContextRequest, signal?: AbortSignal): Promise<ContextBundle> {
    return this.#post(
      '/v1/context',
      { ...request, buildId: request.buildId ?? this.#buildId },
      signal,
    );
  }

  async contextForTaskWithReceipt(
    request: TaskContextRequest,
    signal?: AbortSignal,
  ): Promise<{ bundle: ContextBundle; receipt: ContextReceipt; payload: string }> {
    const captureRequest =
      typeof request.receipt === 'object' && request.receipt.captureRequest === true;
    return this.#send(
      '/v1/context',
      {
        method: 'POST',
        body: JSON.stringify({
          ...request,
          buildId: request.buildId ?? this.#buildId,
          receipt: { captureRequest },
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      signal,
      async (parsed, payload, response) => {
        try {
          const bundle = parsed as ContextBundle;
          const receipt = await verifyHttpReceipt(
            response.headers.get('Lorepack-Context-Receipt'),
            payload,
            bundle,
            captureRequest,
          );
          return { bundle, receipt, payload };
        } catch {
          throw new LoreClientError({
            code: 'LORE_E_SCHEMA_MISMATCH',
            status: response.status,
            message: 'The detached context receipt or emitted payload failed its integrity check.',
            remediation:
              'Use a runtime that supports version1 receipts and retain the original response bytes.',
          });
        }
      },
    );
  }

  listSources(options: SourceListRequest = {}, signal?: AbortSignal): Promise<SourceListResult> {
    return this.#get(sourcePath('/v1/sources', options), signal);
  }

  readSource(
    artifactId: string,
    options: SourceReadOptions = {},
    signal?: AbortSignal,
  ): Promise<SourceReadResult> {
    return this.#get(sourcePath(`/v1/sources/${encodeURIComponent(artifactId)}`, options), signal);
  }

  listTables(signal?: AbortSignal): Promise<TableListResult> {
    return this.#get('/v1/tables', signal);
  }

  describeTable(tableId: string, signal?: AbortSignal): Promise<TableDescription> {
    return this.#get(`/v1/tables/${encodeURIComponent(tableId)}`, signal);
  }

  queryTable(
    tableId: string,
    sql: string,
    options: { limit?: number; buildId?: string } = {},
    signal?: AbortSignal,
  ): Promise<TableQueryResult> {
    return this.#post(
      `/v1/tables/${encodeURIComponent(tableId)}/query`,
      { tableId, sql, ...options, buildId: options.buildId ?? this.#buildId },
      signal,
    );
  }

  /**
   * Retried, because a GET here changes nothing and a cold server may not be listening yet.
   * Bounded exponential backoff, and never on a response the server actually produced: a
   * 400 means the request was wrong, and asking again more slowly will not fix it.
   */
  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (this.#buildId !== undefined && path !== '/health') {
      const url = new URL(path, `${this.#baseUrl}/`);
      if (!url.searchParams.has('buildId')) url.searchParams.set('buildId', this.#buildId);
      path = `${url.pathname}${url.search}`;
    }
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

  async #send<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    transform?: (parsed: unknown, payload: string, response: Response) => Promise<T>,
  ): Promise<T> {
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

    const selected =
      new URL(path, `${this.#baseUrl}/`).searchParams.get('buildId') ??
      (typeof init.body === 'string'
        ? (JSON.parse(init.body) as { buildId?: string }).buildId
        : undefined);
    if (
      selected !== undefined &&
      selected !== null &&
      (parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as { buildId?: unknown }).buildId !== selected)
    ) {
      throw new LoreClientError({
        code: 'LORE_E_SCHEMA_MISMATCH',
        status: response.status,
        message: 'The runtime response does not prove it read the selected build.',
        remediation:
          'Use a runtime that supports exact retained-build selection. No active fallback is accepted.',
        subject: selected,
      });
    }
    return transform === undefined ? (parsed as T) : transform(parsed, text, response);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Preserve each heading verbatim as a separate query parameter. */
function sourcePath(path: string, options: SourceListRequest | SourceReadOptions): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === 'headingPath') {
      for (const heading of (value ?? []) as readonly string[]) query.append(key, heading);
    } else query.set(key, String(value));
  }
  return `${path}${query.size === 0 ? '' : `?${query}`}`;
}
