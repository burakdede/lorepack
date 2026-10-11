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

/**
 * Text from outside Lorepack, made safe to print to a terminal (#579).
 *
 * File names and document content come from a corpus that is often someone else's. Printed
 * raw, an escape sequence in either can set the terminal title, plant an OSC 8 hyperlink whose
 * visible text differs from its target, clear the screen, or, where the terminal allows it,
 * write the clipboard (OSC 52). So every C0 control except tab and newline, DEL, and every C1
 * control is replaced with a visible `\xNN`, which a person can still read and report. A
 * Windows line ending is a newline, not a control to show.
 *
 * Applied to every human string on its way out, and before Lorepack's own styling, which is
 * the only escape sequence that reaches the terminal. Structured JSON bypasses this human
 * formatter to preserve source values. JSON serialization escapes C0 characters, not C1.
 */
export function sanitizeForTerminal(text: string): string {
  let out = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)) continue;
    out += text.slice(start, index);
    start = index + 1;
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) continue;
    out += `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return start === 0 ? text : out + text.slice(start);
}
