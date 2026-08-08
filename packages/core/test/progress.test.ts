import { describe, expect, it } from 'vitest';
import { ProgressBus, type ProgressEvent } from '../src/progress/events.js';
import { ProgressRenderer, shouldUseColor } from '../src/progress/renderer.js';

const ESC = String.fromCharCode(27);

function collector(): { events: ProgressEvent[]; listener: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, listener: (e) => events.push(e) };
}

describe('ProgressBus', () => {
  it('delivers typed events to every subscriber', () => {
    let clock = 1000;
    const bus = new ProgressBus(() => clock);
    const a = collector();
    const b = collector();
    bus.subscribe(a.listener);
    bus.subscribe(b.listener);

    bus.start('parsing', 'Parsing', 184);
    clock += 500;
    bus.progress('parsing', 50, { unit: 'documents' });
    bus.finish('parsing', 184);

    expect(a.events.map((e) => e.type)).toEqual([
      'stage-started',
      'stage-progress',
      'stage-finished',
    ]);
    expect(b.events).toHaveLength(3);
    expect(a.events[1]).toMatchObject({ completed: 50, unit: 'documents', at: 1500 });
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new ProgressBus();
    const c = collector();
    const off = bus.subscribe(c.listener);
    bus.start('indexing', 'Indexing');
    off();
    bus.finish('indexing', 1);
    expect(c.events).toHaveLength(1);
  });
});

describe('ProgressRenderer', () => {
  function setup(
    isTty: boolean,
    minUpdateIntervalMs = 1000,
    extra: { color?: boolean; columns?: number } = {},
  ) {
    const out: string[] = [];
    const renderer = new ProgressRenderer({
      write: (t) => out.push(t),
      isTty,
      minUpdateIntervalMs,
      ...extra,
    });
    return { out, renderer, text: () => out.join('') };
  }

  it('emits at least one measurable update per second during a slow stage', () => {
    const { renderer, text } = setup(false);
    let clock = 0;
    renderer.handle({
      type: 'stage-started',
      stage: 'parsing',
      label: 'Parsing',
      total: 900,
      at: clock,
    });
    // Ten seconds of work, reported far more often than once per second.
    for (let i = 1; i <= 100; i += 1) {
      clock += 100;
      renderer.handle({
        type: 'stage-progress',
        stage: 'parsing',
        completed: i * 9,
        total: 900,
        at: clock,
      });
    }
    renderer.handle({
      type: 'stage-finished',
      stage: 'parsing',
      completed: 900,
      outcome: 'done',
      at: clock,
    });

    const lines = text().trimEnd().split('\n');
    // One start, at least ten throttled updates across ten seconds, one finish.
    expect(lines.length).toBeGreaterThanOrEqual(12);
    // Every line carries a measurable count rather than a spinner frame.
    for (const line of lines) expect(line).toMatch(/\d/);
  });

  it('throttles bursts to the configured interval', () => {
    const { renderer, out } = setup(false, 1000);
    renderer.handle({ type: 'stage-started', stage: 'indexing', label: 'Indexing', at: 0 });
    for (let i = 1; i <= 50; i += 1) {
      renderer.handle({ type: 'stage-progress', stage: 'indexing', completed: i, at: 10 * i });
    }
    // The start line plus a single throttled update inside the first second.
    expect(out).toHaveLength(2);
  });

  it('produces escape-free, line-per-update output when not a TTY', () => {
    const { renderer, text } = setup(false);
    renderer.handle({ type: 'stage-started', stage: 'discovering', label: 'Discovering', at: 0 });
    renderer.handle({
      type: 'stage-finished',
      stage: 'discovering',
      completed: 184,
      outcome: 'done',
      at: 20,
    });
    expect(text()).not.toContain(ESC);
    expect(text()).not.toContain('\r');
    expect(text()).toContain('Discovering');
    expect(text()).toContain('184');
  });

  it('rewrites in place on a TTY and closes the line when finished', () => {
    const { renderer, text } = setup(true);
    renderer.handle({ type: 'stage-started', stage: 'parsing', label: 'Parsing', at: 0 });
    renderer.handle({ type: 'stage-progress', stage: 'parsing', completed: 10, at: 2000 });
    renderer.handle({
      type: 'stage-finished',
      stage: 'parsing',
      completed: 10,
      outcome: 'done',
      at: 3000,
    });
    expect(text()).toContain('\r');
    expect(text().endsWith('\n')).toBe(true);
  });

  it('formats counts in the architecture section 6.4 shape', () => {
    const { renderer, text } = setup(false);
    renderer.handle({ type: 'stage-started', stage: 'indexing', label: 'Indexing', at: 0 });
    renderer.handle({
      type: 'stage-finished',
      stage: 'indexing',
      completed: 12418,
      outcome: 'done',
      at: 500,
    });
    expect(text()).toContain('12,418');
    expect(text()).toContain('done');
  });

  it('renders a summary block', () => {
    const { renderer, text } = setup(false);
    renderer.summary([
      ['Build', 'lore_b7f2a9c1d4e8'],
      ['Reused', '0 artifacts (first build)'],
    ]);
    expect(text()).toContain('Build           lore_b7f2a9c1d4e8');
    expect(text()).toContain('Reused');
  });

  it('reports a failed stage outcome rather than pretending it finished', () => {
    const { renderer, text } = setup(false);
    renderer.handle({ type: 'stage-started', stage: 'validating', label: 'Validating', at: 0 });
    renderer.handle({
      type: 'stage-finished',
      stage: 'validating',
      completed: 3,
      outcome: 'failed',
      at: 10,
    });
    expect(text()).toContain('failed');
  });

  it('writes diagnostics on their own line without disturbing the table', () => {
    const { renderer, text } = setup(true);
    renderer.handle({ type: 'stage-started', stage: 'parsing', label: 'Parsing', at: 0 });
    renderer.handle({ type: 'diagnostic', level: 'warn', message: '2 unsupported files', at: 1 });
    expect(text()).toContain('warn: 2 unsupported files');
  });

  it('renders progress detail beside measurable counts, which deploy uses for bytes and objects', () => {
    const { renderer, text } = setup(false);
    renderer.handle({ type: 'stage-started', stage: 'uploading', label: 'Uploading', at: 0 });
    renderer.handle({
      type: 'stage-progress',
      stage: 'uploading',
      completed: 2048,
      total: 4096,
      unit: 'bytes',
      detail: '1/2 objects, 1 uploaded, 0 skipped',
      at: 1200,
    });
    expect(text()).toContain('2,048/4,096 bytes 1/2 objects, 1 uploaded, 0 skipped');
  });
});

describe('shouldUseColor', () => {
  it.each([
    [{}, true, true],
    [{}, false, false],
    [{ NO_COLOR: '1' }, true, false],
    [{ FORCE_COLOR: '1' }, false, true],
    [{ FORCE_COLOR: '0' }, true, false],
  ])('env %o on tty %s gives %s', (env, isTty, expected) => {
    expect(shouldUseColor(env as NodeJS.ProcessEnv, isTty)).toBe(expected);
  });
});

describe('colour and terminal width', () => {
  /**
   * Both were documented, resolved, threaded into the renderer and then never applied
   * (#169). A flag nobody can observe is worse than no flag: the manual checklist asked a
   * person to confirm colour disappeared when there was none to disappear.
   */
  function render(options: { color?: boolean; columns?: number }): string {
    const out: string[] = [];
    const renderer = new ProgressRenderer({
      write: (t) => out.push(t),
      isTty: true,
      ...options,
    });
    renderer.handle({
      type: 'stage-started',
      stage: 'parsing',
      label: 'Parsing',
      total: 500,
      at: 0,
    });
    renderer.handle({
      type: 'stage-finished',
      stage: 'parsing',
      completed: 500,
      outcome: 'done',
      at: 1200,
    });
    return out.join('');
  }

  const visible = (text: string): string[] =>
    text
      .replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g'), '')
      .split(/[\r\n]/)
      .filter((line) => line !== '');

  it('colours the status word when colour is on', () => {
    expect(render({ color: true })).toContain(ESC);
  });

  it('emits nothing but text when colour is off, which is what a log needs', () => {
    expect(render({ color: false })).not.toContain(ESC);
    expect(render({})).not.toContain(ESC);
  });

  it.each([20, 30, 40, 60, 80, 200])(
    'keeps every update inside %i columns, so one update is one row',
    (columns) => {
      for (const line of visible(render({ columns }))) {
        expect(line.length, line).toBeLessThan(columns);
      }
    },
  );

  it('drops the counts before the status, because the status is what a reader waits for', () => {
    // Truncating from the right would leave a column of padding and no `done`.
    expect(visible(render({ columns: 40 })).at(-1)).toContain('done');
  });

  it('stays exactly as it was when the width is unknown, as in a pipe', () => {
    const line = visible(render({})).at(-1) ?? '';
    expect(line).toMatch(/^Parsing +500\/500 +done$/);
    expect(line).toHaveLength(52);
  });

  it('does not count escapes toward the width', () => {
    for (const line of visible(render({ columns: 40, color: true }))) {
      expect(line.length).toBeLessThan(40);
    }
  });
});
