import { style } from '../format/ansi.js';
import { causeChain, LoreError } from './lore-error.js';
import { redact, redactDeep, secretsFromEnv } from './redact.js';

export interface RenderOptions {
  readonly secrets?: readonly string[];
  readonly verbose?: boolean;
  /**
   * Colour, when the caller has decided the stream can take it. Only the two words a reader
   * scans for are coloured: what went wrong, and what to do about it. `--json` never passes
   * this, because a machine-readable stream with escapes in it is not machine-readable.
   */
  readonly color?: boolean;
}

/** Human-readable CLI rendering: summary, subject, cause chain, then one next step. */
export function renderForCli(error: unknown, options: RenderOptions = {}): string {
  const err = LoreError.from(error);
  const secrets = options.secrets ?? secretsFromEnv();
  const color = options.color === true;
  const lines: string[] = [
    `${style('error:', 'red', color)} ${redact(err.message, secrets)}`,
    style(`  code: ${err.code}`, 'dim', color),
  ];

  // An empty value is not a subject. Rendering `subject:` with nothing after it tells the
  // reader the error is about something and then refuses to say what (#166).
  if (present(err.path)) lines.push(`  path: ${redact(err.path as string, secrets)}`);
  if (present(err.subject)) lines.push(`  subject: ${redact(err.subject as string, secrets)}`);

  const causes = causeChain(err);
  if (causes.length > 0) {
    lines.push('  caused by:');
    for (const cause of causes) lines.push(`    ${redact(cause, secrets)}`);
  }

  if (options.verbose === true && err.details !== undefined) {
    lines.push(`  details: ${JSON.stringify(redactDeep(err.details, secrets))}`);
  }

  lines.push('');
  lines.push(
    err.remediation !== undefined
      ? `${style('next:', 'green', color)} ${redact(err.remediation, secrets)}`
      : // `lore doctor` names what is wrong with an environment and how to fix it, which is
        // the most useful thing to offer when the failure itself carried no remediation.
        //
        // The ordering here was the trap: this named `lore doctor` before the command
        // existed, so every unclassified failure sent the user to something the binary did
        // not have (#168). It was restored only once #56 registered it, which is what
        // `scripts/check-command-set.mjs` now enforces on every build.
        `${style('next:', 'green', color)} run \`lore doctor\` to check this environment, and include ${err.code} when reporting this.`,
  );
  return lines.join('\n');
}

export interface JsonError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
    readonly path?: string;
    readonly subject?: string;
    readonly causes?: readonly string[];
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** Structured rendering shared by `--json`, the REST API, and the MCP adapter. */
export function renderAsJson(error: unknown, options: RenderOptions = {}): JsonError {
  const err = LoreError.from(error);
  const secrets = options.secrets ?? secretsFromEnv();
  const causes = causeChain(err);
  return {
    error: {
      code: err.code,
      message: redact(err.message, secrets),
      ...(err.remediation !== undefined ? { remediation: redact(err.remediation, secrets) } : {}),
      ...(present(err.path) ? { path: redact(err.path as string, secrets) } : {}),
      ...(present(err.subject) ? { subject: redact(err.subject as string, secrets) } : {}),
      ...(causes.length > 0 ? { causes: causes.map((c) => redact(c, secrets)) } : {}),
      ...(err.details !== undefined ? { details: redactDeep(err.details, secrets) } : {}),
    },
  };
}

/**
 * Protocol-facing rendering. Absolute paths never cross this boundary: a model-facing
 * error must not disclose the filesystem layout outside the project.
 */
export function renderForProtocol(
  error: unknown,
  options: RenderOptions = {},
): {
  code: string;
  message: string;
} {
  const err = LoreError.from(error);
  const secrets = options.secrets ?? secretsFromEnv();
  const message = [redact(err.message, secrets), err.remediation]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' ');
  return { code: err.code, message: stripAbsolutePaths(redact(message, secrets)) };
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s"']*|\/(?:home|Users|var|tmp|opt|etc|root)\/[^\s"']*)/g;

export function stripAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, '<path>');
}

/** A field worth rendering: set, and not the empty string. */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}
