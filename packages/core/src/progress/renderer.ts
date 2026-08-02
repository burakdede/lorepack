import { CLEAR_LINE, style } from '../format/ansi.js';
import type { ProgressEvent, StageName } from './events.js';

export interface RendererOptions {
  /** Where progress goes. In `lore mcp` this must be stderr: stdout carries protocol only. */
  readonly write: (text: string) => void;
  readonly isTty?: boolean;
  readonly color?: boolean;
  /**
   * The terminal width, when there is one. A line wider than the terminal wraps, and the
   * `\r` that rewrites it then returns to the start of the last physical row, leaving the
   * earlier row stranded: every update adds another (#169). Truncating is the fix, and
   * needing the width is why the renderer has to be told it.
   */
  readonly columns?: number | undefined;
  /** Architecture section 5.5 requires at least one visible update per second. */
  readonly minUpdateIntervalMs?: number;
  readonly now?: () => number;
}

interface StageState {
  label: string;
  completed: number;
  total: number | undefined;
  unit: string | undefined;
  startedAt: number;
  lastRenderAt: number;
  finished: boolean;
}

const LABEL_WIDTH = 16;
/** Where the status word starts on a terminal wide enough to hold the whole line. */
const STATUS_COLUMN = 48;
/** Below this much room for the label, the status is dropped rather than the label. */
const MINIMUM_LABEL = 8;

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Lays out one update so it occupies one physical row, whatever the terminal is.
 *
 * One column is left free: writing into the last column puts the cursor there, and a
 * terminal that wraps eagerly then treats the next write as a new row, which is the wrap
 * this exists to avoid.
 *
 * When the row is too narrow, the counts give way and the status stays. `done` and the
 * elapsed time are the part a reader is waiting for; truncating from the right would drop
 * exactly that and leave a column of padding.
 */
function layout(left: string, status: string, columns: number | undefined): string {
  const padded = left.padEnd(STATUS_COLUMN) + status;
  if (columns === undefined || columns <= 1) return padded;

  const room = columns - 1;
  if (padded.length <= room) return padded;
  if (room < status.length + MINIMUM_LABEL) return left.slice(0, room);
  return `${left.slice(0, room - status.length - 1)} ${status}`;
}

/**
 * Renders the stage table from architecture section 6.4. In a non-TTY (CI) it emits
 * plain, ANSI-free lines; in a TTY it rewrites the current line in place.
 */
export class ProgressRenderer {
  #options: Required<Omit<RendererOptions, 'write'>> & Pick<RendererOptions, 'write'>;
  #stages = new Map<StageName, StageState>();
  #currentLineDirty = false;

  constructor(options: RendererOptions) {
    this.#options = {
      isTty: options.isTty ?? false,
      color: options.color ?? false,
      columns: options.columns,
      minUpdateIntervalMs: options.minUpdateIntervalMs ?? 1000,
      now: options.now ?? Date.now,
      write: options.write,
    };
  }

  handle(event: ProgressEvent): void {
    switch (event.type) {
      case 'stage-started':
        this.#stages.set(event.stage, {
          label: event.label,
          completed: 0,
          total: event.total,
          unit: undefined,
          startedAt: event.at,
          lastRenderAt: 0,
          finished: false,
        });
        this.#render(event.stage, event.at, false);
        break;
      case 'stage-progress': {
        const state = this.#stages.get(event.stage);
        if (state === undefined) return;
        state.completed = event.completed;
        if (event.total !== undefined) state.total = event.total;
        if (event.unit !== undefined) state.unit = event.unit;
        this.#render(event.stage, event.at, false);
        break;
      }
      case 'stage-finished': {
        const state = this.#stages.get(event.stage);
        if (state === undefined) return;
        state.completed = event.completed;
        state.finished = true;
        this.#render(event.stage, event.at, true, event.outcome);
        break;
      }
      case 'diagnostic':
        this.#finishLine();
        this.#options.write(`${event.level}: ${event.message}\n`);
        break;
    }
  }

  #render(
    stage: StageName,
    at: number,
    force: boolean,
    outcome: 'done' | 'skipped' | 'failed' = 'done',
  ): void {
    const state = this.#stages.get(stage);
    if (state === undefined) return;

    const dueForUpdate = at - state.lastRenderAt >= this.#options.minUpdateIntervalMs;
    if (!force && !dueForUpdate && state.lastRenderAt !== 0) return;
    state.lastRenderAt = at;

    const label = state.label.padEnd(LABEL_WIDTH);
    const counted =
      state.total !== undefined
        ? `${formatCount(state.completed)}/${formatCount(state.total)}`
        : formatCount(state.completed);
    const unit = state.unit === undefined ? '' : ` ${state.unit}`;
    const elapsed = formatElapsed(at - state.startedAt);
    const status = state.finished ? outcome : elapsed;

    // Laid out before it is coloured, so a style never counts toward the width and never
    // gets cut in half, which would leave the rest of the terminal wearing the colour.
    const plain = layout(`${label}${counted}${unit}`, status, this.#options.columns);
    const line = this.#paint(plain, state.finished ? outcome : null);

    if (this.#options.isTty && !state.finished) {
      // Clear to the end of the line as well as returning to its start: without it, a
      // shorter update leaves the tail of the longer one it replaced.
      this.#options.write(`\r${line}${this.#options.color ? CLEAR_LINE : ''}`);
      this.#currentLineDirty = true;
    } else {
      this.#finishLine();
      this.#options.write(`${line}\n`);
    }
  }

  /** The status word carries the meaning, so it is the only part worth colouring. */
  #paint(line: string, outcome: 'done' | 'skipped' | 'failed' | null): string {
    if (!this.#options.color || outcome === null) return line;
    if (!line.endsWith(outcome)) return line;
    const head = line.slice(0, line.length - outcome.length);
    const name = outcome === 'failed' ? 'red' : outcome === 'skipped' ? 'yellow' : 'green';
    return head + style(outcome, name, true);
  }

  #finishLine(): void {
    if (this.#currentLineDirty) {
      this.#options.write('\n');
      this.#currentLineDirty = false;
    }
  }

  /** Summary block printed after the stage table. */
  summary(rows: ReadonlyArray<readonly [string, string]>): void {
    this.#finishLine();
    this.#options.write('\n');
    for (const [key, value] of rows) {
      this.#options.write(`${key.padEnd(LABEL_WIDTH)}${value}\n`);
    }
  }
}

/**
 * NO_COLOR wins outright. FORCE_COLOR is authoritative in both directions: `0` disables
 * colour even on a TTY, which is the convention the wider ecosystem follows.
 */
export function shouldUseColor(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
  return isTty;
}
