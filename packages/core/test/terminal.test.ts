import { describe, expect, it } from 'vitest';
import { LoreError } from '../src/errors/lore-error.js';
import { renderForCli } from '../src/errors/render.js';
import { sanitizeForTerminal } from '../src/format/ansi.js';
import { ProgressRenderer } from '../src/progress/renderer.js';

/**
 * Corpus text on its way to a terminal (#579).
 *
 * Each case is a sequence a hostile file name or document could carry: the title, an OSC 8
 * link, a screen clear, a C1 CSI, a bare carriage return. The assertion is the same throughout:
 * none reaches the terminal as a control, and each is still visible as text.
 */

const ESC = '\u001b';

describe('sanitizeForTerminal', () => {
  it('shows C0 controls, DEL and C1 controls as visible escapes', () => {
    expect(sanitizeForTerminal(`a${ESC}]0;PWNED\u0007b`)).toBe('a\\x1b]0;PWNED\\x07b');
    expect(sanitizeForTerminal(`${ESC}[2J`)).toBe('\\x1b[2J');
    expect(sanitizeForTerminal('\u009b31m\u007f\u0000')).toBe('\\x9b31m\\x7f\\x00');
  });

  it('keeps tab and newline, and reads a Windows line ending as a newline', () => {
    expect(sanitizeForTerminal('a\tb\nc\r\nd')).toBe('a\tb\nc\nd');
  });

  it('shows a bare carriage return, which could overwrite what came before it', () => {
    expect(sanitizeForTerminal('safe\rspoofed')).toBe('safe\\x0dspoofed');
  });

  it('returns ordinary text unchanged, including non-ASCII', () => {
    const text = 'docs/caf\u00e9 \u{1F600} r\u00e9sum\u00e9.md';
    expect(sanitizeForTerminal(text)).toBe(text);
  });
});

describe('the renderers that print corpus text', () => {
  it('render an error inert, and still colour their own labels', () => {
    const error = new LoreError('LORE_E_SOURCE_UNREADABLE', `Cannot read docs/x${ESC}[2J.md.`, {
      path: `docs/x${ESC}]8;;http://evil.example${ESC}\\.md`,
      remediation: 'Fix it.',
    });

    const rendered = renderForCli(error, { color: true, secrets: [] });

    expect(rendered).toContain('docs/x\\x1b[2J.md');
    expect(rendered).toContain('\\x1b]8;;http://evil.example');
    // Lorepack's own colours are the only sequences left.
    const own = ['[31m', '[39m', '[32m', '[2m', '[22m'].map((code) => `${ESC}${code}`);
    expect(own.reduce((text, code) => text.replaceAll(code, ''), rendered)).not.toContain(ESC);
  });

  it('render progress inert, labels, details and diagnostics alike', () => {
    let written = '';
    const renderer = new ProgressRenderer({ write: (text) => (written += text), isTty: false });

    renderer.handle({
      type: 'stage-started',
      stage: 'parsing',
      label: `P${ESC}[2J`,
      total: 1,
      at: 0,
    });
    renderer.handle({
      type: 'stage-progress',
      stage: 'parsing',
      completed: 1,
      detail: `docs/${ESC}]0;t\u0007.md`,
      at: 5000,
    });
    renderer.handle({ type: 'diagnostic', level: 'warn', message: `bad ${ESC}[31m`, at: 5001 });
    renderer.summary([[`k${ESC}`, `v\u009b`]]);

    expect(written).not.toContain(ESC);
    expect(written).not.toContain('\u0007');
    expect(written).not.toContain('\u009b');
    expect(written).toContain('docs/\\x1b]0;t\\x07.md');
  });
});
