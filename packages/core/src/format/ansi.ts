/**
 * The smallest colour surface that is worth having, with no dependency.
 *
 * `--no-color`, `NO_COLOR` and `FORCE_COLOR` were documented, resolved and threaded into
 * the renderer, and then never applied to anything: the flag was inert and the manual
 * checklist asked a person to verify that colour disappeared when there was none (#169).
 * Either the promise or the feature had to go, and the plumbing was already built.
 *
 * Four styles, chosen because each one carries meaning a reader uses: what failed, what
 * succeeded, what is merely context. Anything more becomes decoration that has to be
 * maintained across every renderer.
 */

/** Written as an escape rather than a literal byte, so the source stays readable text. */
const ESC = '\u001b';

const CODES = {
  red: [`${ESC}[31m`, `${ESC}[39m`],
  green: [`${ESC}[32m`, `${ESC}[39m`],
  yellow: [`${ESC}[33m`, `${ESC}[39m`],
  dim: [`${ESC}[2m`, `${ESC}[22m`],
} as const;

export type Style = keyof typeof CODES;

/** Wraps text when colour is on, and is the identity when it is off. */
export function style(text: string, name: Style, enabled: boolean): string {
  if (!enabled) return text;
  const [open, close] = CODES[name];
  return `${open}${text}${close}`;
}

/** Clears from the cursor to the end of the line. Only ever written to a TTY. */
export const CLEAR_LINE = `${ESC}[K`;

/** Length as a terminal counts it, so a coloured string still truncates correctly. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function stripAnsi(text: string): string {
  return text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g'), '');
}
