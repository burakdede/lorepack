/**
 * Redaction is a property of the renderer, not of each call site. A message that
 * happens to embed a token must not leak it, however it was constructed.
 * Architecture section 19.4.
 */

const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|API[_-]?KEY|AUTH)/i;
const MIN_SECRET_LENGTH = 8;
export const REDACTED = '[redacted]';

function defaultEnv(): Record<string, string | undefined> {
  return typeof process === 'object' && process !== null && 'env' in process
    ? ((process as { env: Record<string, string | undefined> }).env ?? {})
    : {};
}

/** Values worth hiding, drawn from the environment at render time. */
export function secretsFromEnv(env: Record<string, string | undefined> = defaultEnv()): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_ENV_PATTERN.test(name)) values.push(value);
  }
  // Longest first, so a value containing another is redacted whole.
  return values.sort((a, b) => b.length - a.length);
}

const INLINE_PATTERNS: readonly RegExp[] = [
  // Bearer tokens and Authorization headers.
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  // Common provider-style prefixed keys.
  /\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[baprs])[-_][A-Za-z0-9_]{12,}\b/g,
  // key=value and key: value pairs whose name looks secret.
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("[^"\n]+"|'[^'\n]+'|\S+)/gi,
];

export function redact(text: string, secrets: readonly string[] = secretsFromEnv()): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    output = output.split(secret).join(REDACTED);
  }
  output = output.replace(INLINE_PATTERNS[0] as RegExp, `$1${REDACTED}`);
  output = output.replace(INLINE_PATTERNS[1] as RegExp, REDACTED);
  output = output.replace(INLINE_PATTERNS[2] as RegExp, `$1=${REDACTED}`);
  return output;
}

export function redactDeep<T>(value: T, secrets: readonly string[] = secretsFromEnv()): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out as T;
  }
  return value;
}
