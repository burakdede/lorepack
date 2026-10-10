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

/** Bearer tokens and Authorization headers. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi;
/** Common provider-style prefixed keys. */
const PREFIXED_KEY = /\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[baprs])[-_][A-Za-z0-9_]{12,}\b/g;

/**
 * A `key=value` or `key: value` pair, found in two steps so the cost stays linear (#551).
 *
 * One pattern with the keyword in the middle of the name,
 * `[A-Za-z0-9_]*(?:TOKEN|...)[A-Za-z0-9_]*\s*[=:]`, backtracks across the rest of the word for
 * every keyword inside it, which is quadratic in the word's length. A caller controls that
 * word: a JSON key echoed into a validation error is enough. So the pair is found by a pattern
 * that never has to guess where the keyword is, and the name is tested afterwards.
 */
const PAIR_NAME = /\b([A-Za-z0-9_-]+)\s*[=:]\s*/y;
const PAIR_VALUE = /"[^"\n]+"|'[^'\n]+'|\S+/y;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL/i;
/** Where a pair name can start: the first word character after a non-word one. */
const WORD_START = /\b(?=[A-Za-z0-9_])/g;

function redactPairs(text: string): string {
  let output = '';
  let copied = 0;
  WORD_START.lastIndex = 0;
  for (let start = WORD_START.exec(text); start !== null; start = WORD_START.exec(text)) {
    PAIR_NAME.lastIndex = start.index;
    const pair = PAIR_NAME.exec(text);
    if (pair === null) {
      // Retrying after each hyphen would rescan the remaining name quadratically.
      WORD_START.lastIndex = endOfName(text, start.index);
      continue;
    }
    const name = pair[1] as string;
    PAIR_VALUE.lastIndex = PAIR_NAME.lastIndex;
    const value = SECRET_NAME.test(name) ? PAIR_VALUE.exec(text) : null;
    if (value === null) {
      // Not a secret: the value is ordinary text and is scanned like the rest, so a secret
      // pair inside it (`a=MY_TOKEN=x`) is still found.
      WORD_START.lastIndex = endOfName(text, start.index);
      continue;
    }
    output += `${text.slice(copied, start.index)}${name}=${REDACTED}`;
    copied = PAIR_VALUE.lastIndex;
    WORD_START.lastIndex = copied;
  }
  return output + text.slice(copied);
}

function endOfName(text: string, from: number): number {
  let index = from;
  while (index < text.length && /[A-Za-z0-9_-]/.test(text[index] as string)) index += 1;
  return index;
}

export function redact(text: string, secrets: readonly string[] = secretsFromEnv()): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    output = output.split(secret).join(REDACTED);
  }
  output = output.replace(BEARER, `$1${REDACTED}`);
  output = output.replace(PREFIXED_KEY, REDACTED);
  return redactPairs(output);
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
