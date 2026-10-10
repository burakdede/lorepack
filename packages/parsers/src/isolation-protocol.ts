import { type ErrorCode, LoreError, type ParsedArtifact } from '@lorepack/core';

/**
 * What crosses the process boundary between `ParserHost` and `parse-child.ts`.
 *
 * Errors are carried as data and rebuilt on the other side, because the distinction the build
 * depends on (#242: a parser's own `LoreError` keeps its code, anything else is a genuine
 * surprise) is a class identity, and no serializer preserves a class.
 */

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly lore?: {
    readonly code: ErrorCode;
    readonly remediation?: string;
    readonly path?: string;
    readonly subject?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly cause?: SerializedError;
}

export type ChildReply =
  | { readonly kind: 'ready' }
  | { readonly kind: 'parsed'; readonly result: ParsedArtifact }
  | { readonly kind: 'failed'; readonly error: SerializedError };

/** Cause chains are short in practice; the bound only stops a cyclic one from looping. */
const MAX_CAUSE_DEPTH = 8;

export function serializeError(value: unknown, depth = 0): SerializedError {
  if (!(value instanceof Error)) return { name: 'Error', message: String(value) };
  const cause =
    value.cause === undefined || depth >= MAX_CAUSE_DEPTH
      ? undefined
      : serializeError(value.cause, depth + 1);
  return {
    name: value.name,
    message: value.message,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
    ...(value instanceof LoreError
      ? {
          lore: {
            code: value.code,
            ...(value.remediation === undefined ? {} : { remediation: value.remediation }),
            ...(value.path === undefined ? {} : { path: value.path }),
            ...(value.subject === undefined ? {} : { subject: value.subject }),
            ...(value.details === undefined ? {} : { details: value.details }),
          },
        }
      : {}),
    ...(cause === undefined ? {} : { cause }),
  };
}

export function deserializeError(serialized: SerializedError): Error {
  const cause = serialized.cause === undefined ? undefined : deserializeError(serialized.cause);
  if (serialized.lore !== undefined) {
    const { code, ...options } = serialized.lore;
    const error = new LoreError(code, serialized.message, {
      ...options,
      ...(cause === undefined ? {} : { cause }),
    });
    if (serialized.stack !== undefined) error.stack = serialized.stack;
    return error;
  }
  const error = new Error(serialized.message, cause === undefined ? undefined : { cause });
  error.name = serialized.name;
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  return error;
}
