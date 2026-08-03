import { LoreClient, LoreClientError } from '@lorepack/sdk';

/**
 * Studio's only route to data.
 *
 * Architecture 9.1: Studio talks to the HTTP API and nothing else. Going through
 * `@lorepack/sdk` rather than `fetch` means route code cannot invent a request shape, and the
 * type-equality test in `tools/contract` already fails if the SDK and the server disagree, so
 * Studio inherits that guarantee for free.
 *
 * The base URL is the origin Studio was served from. It is served by the same Hono app that
 * answers `/v1`, on one port, so there is nothing to configure and no way to point it at a
 * server the user did not start.
 */
export const client = new LoreClient({
  baseUrl: typeof window === 'undefined' ? 'http://127.0.0.1:43110' : window.location.origin,
});

/** The taxonomy's shape, as it survives the SDK. */
export interface DisplayableError {
  readonly message: string;
  readonly code?: string;
  readonly remediation?: string;
}

/**
 * Turns anything thrown into something the interface can show.
 *
 * A failure explains what happened and how to fix it. The remediation comes from the Phase 0
 * taxonomy over the wire, so Studio says exactly what the CLI would rather than paraphrasing
 * it into something friendlier and less useful.
 */
interface Wire {
  readonly message: string;
  readonly code?: unknown;
  readonly remediation?: unknown;
}

export function toDisplayable(error: unknown): DisplayableError {
  if (error instanceof LoreClientError) {
    return {
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
    };
  }
  // A parsed error body, thrown by a route that fetched directly rather than through the
  // SDK. The wire shape is `{ error: { code, message, remediation } }`, and the whole point
  // of the taxonomy is that this reaches the reader intact rather than as "[object Object]".
  const body = (error as { error?: unknown } | null)?.error;
  if (typeof body === 'object' && body !== null && typeof (body as Wire).message === 'string') {
    const wire = body as Wire;
    return {
      message: wire.message,
      ...(typeof wire.code === 'string' ? { code: wire.code } : {}),
      ...(typeof wire.remediation === 'string' ? { remediation: wire.remediation } : {}),
    };
  }

  if (error instanceof Error) {
    // The common case here is the dev server having stopped, and saying so is more useful
    // than reporting a fetch failure.
    return {
      message: error.message,
      remediation: 'Check that `lore dev` is still running in your terminal.',
    };
  }
  return { message: String(error) };
}
