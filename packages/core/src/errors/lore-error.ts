import { ERROR_CODES, type ErrorCode, type ExitCode, exitCodeFor } from './codes.js';

export interface LoreErrorOptions {
  /** One concrete action the user can take. Every error should offer one. */
  readonly remediation?: string;
  /** Project-relative path this error is about, never an absolute path. */
  readonly path?: string;
  /** Artifact, build, or table identifier this error is about. */
  readonly subject?: string;
  /** Structured detail for machine consumers. Must not contain secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Every failure Lorepack reports is one of these. A bare `Error` gives the user a stack
 * trace and no next step, which is why the architecture rules forbid it in the packages
 * that face users.
 */
export class LoreError extends Error {
  readonly code: ErrorCode;
  readonly remediation: string | undefined;
  readonly path: string | undefined;
  readonly subject: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, options: LoreErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LoreError';
    this.code = code;
    this.remediation = options.remediation;
    this.path = options.path;
    this.subject = options.subject;
    this.details = options.details;
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code);
  }

  /** The one-line summary of what this code means, independent of the instance. */
  get codeDescription(): string {
    return ERROR_CODES[this.code];
  }

  static is(value: unknown): value is LoreError {
    return value instanceof LoreError;
  }

  /** Wraps an unknown thrown value so callers always have a LoreError to render. */
  static from(value: unknown, code: ErrorCode = 'LORE_E_INTERNAL'): LoreError {
    if (LoreError.is(value)) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new LoreError(code, message, { cause: value });
  }
}

/**
 * The messages beneath the top-level error, outermost first. The top error's own message
 * is rendered separately, so the chain starts at its cause. Cycles are possible when a
 * caller reuses an error object, so visited values are tracked.
 */
export function causeChain(error: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = error instanceof Error ? error.cause : undefined;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      chain.push(current.message);
      current = current.cause;
    } else {
      chain.push(String(current));
      break;
    }
  }
  return chain;
}
