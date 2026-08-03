import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA contrast, computed from the documented tokens themselves.
 *
 * The amendment on #70 asks for exactly this: contrast verified against the token values in
 * `docs/architecture/studio-design.md` rather than against whatever a component library
 * shipped. A browser audit only ever sees the combinations that happened to be on screen,
 * and it sees them in one theme. This checks every pair the design commits to, in both.
 *
 * The ratio is the one from the WCAG definition, not an approximation: relative luminance
 * with the sRGB transfer function, `(lighter + 0.05) / (darker + 0.05)`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, '..', 'src', 'styles.css'), 'utf8');

/** AA for body text, and for anything a person has to read to use the product. */
const BODY = 4.5;
function tokens(selector: string): Record<string, string> {
  // Each theme block is a flat list of custom properties, so the block is found by its
  // selector and the properties are read from it. Deliberately not a CSS parser: a
  // dependency to read six declarations is a dependency to maintain.
  const start = STYLES.indexOf(selector);
  expect(start, `${selector} should exist in styles.css`).toBeGreaterThan(-1);
  const open = STYLES.indexOf('{', start);
  const close = STYLES.indexOf('}', open);
  const block = STYLES.slice(open + 1, close);

  const found: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    found[name] = value.trim();
  }
  return found;
}

function channel(part: number): number {
  const scaled = part / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function ratio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every pair the interface actually puts together, per theme. */
const PAIRS: readonly { foreground: string; background: string; minimum: number }[] = [
  // Body copy and the two quieter text ranks, on both surfaces.
  { foreground: '--text', background: '--bg', minimum: BODY },
  { foreground: '--text', background: '--surface', minimum: BODY },
  { foreground: '--text-secondary', background: '--bg', minimum: BODY },
  { foreground: '--text-secondary', background: '--surface', minimum: BODY },
  // Muted is column headers, timestamps and units: small, and still has to be readable.
  { foreground: '--text-muted', background: '--bg', minimum: BODY },
  { foreground: '--text-muted', background: '--surface', minimum: BODY },
  // State colours, which carry words rather than decoration, on their own tinted grounds.
  { foreground: '--state-ok', background: '--state-ok-bg', minimum: BODY },
  { foreground: '--state-warn', background: '--state-warn-bg', minimum: BODY },
  { foreground: '--state-bad', background: '--state-bad-bg', minimum: BODY },
  { foreground: '--state-ok', background: '--bg', minimum: BODY },
  { foreground: '--state-warn', background: '--bg', minimum: BODY },
  { foreground: '--state-bad', background: '--bg', minimum: BODY },
  // The border a person has to see to tell a control from the page behind it.
  { foreground: '--border', background: '--bg', minimum: 1.3 },
];

describe.each([
  ['light', ':root'],
  ['dark', ':root[data-theme="dark"]'],
])('%s theme', (_theme, selector) => {
  const light = tokens(':root');
  const theme = { ...light, ...tokens(selector) };

  it.each(PAIRS)(
    '$foreground on $background meets its minimum',
    ({ foreground, background, minimum }) => {
      const front = theme[foreground];
      const back = theme[background];
      expect(front, `${foreground} should be defined`).toBeDefined();
      expect(back, `${background} should be defined`).toBeDefined();

      const measured = ratio(front as string, back as string);
      expect(
        measured,
        `${foreground} (${front}) on ${background} (${back}) is ${measured.toFixed(2)}:1, below ${minimum}:1`,
      ).toBeGreaterThanOrEqual(minimum);
    },
  );
});

describe('the tokens the design document commits to', () => {
  it('defines the same scales in both themes, so nothing falls back silently', () => {
    const light = Object.keys(tokens(':root'));
    const dark = Object.keys(tokens(':root[data-theme="dark"]'));

    // The dark block overrides colours and inherits the type, spacing and radius scales, so
    // it is a subset. What must never happen is a colour defined only in light: it would
    // survive into the dark theme with a value chosen for a white page.
    for (const name of dark) expect(light).toContain(name);

    // Every state colour needs a dark value, unless it is an alias: `--state-idle` is
    // `var(--text-muted)`, and a token defined by reference follows whatever the theme sets
    // the referent to. Restating it in the dark block would create a second place to change.
    const values = tokens(':root');
    const literal = light.filter(
      (name) => name.startsWith('--state-') && !(values[name] ?? '').includes('var('),
    );
    for (const name of literal) {
      expect(dark, `${name} needs a dark value`).toContain(name);
    }
  });

  it('has exactly the three state scales, with no accent colour', () => {
    const scales = Object.keys(tokens(':root')).filter(
      (name) => name.startsWith('--state-') && !name.endsWith('-bg'),
    );
    // Colour encodes state and nothing else. An accent is how an interface starts colouring
    // things because they are important rather than because they are true.
    expect(scales.sort()).toEqual(['--state-bad', '--state-idle', '--state-ok', '--state-warn']);
    expect(Object.keys(tokens(':root')).some((name) => name.includes('accent'))).toBe(false);
  });
});
