import type { ProgressEvent, StageName } from './events.js';

export interface RendererOptions {
  /** Where progress goes. In `lore mcp` this must be stderr: stdout carries protocol only. */
  readonly write: (text: string) => void;
  readonly isTty?: boolean;
  readonly color?: boolean;
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

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
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
    const line = `${label}${counted}${unit}`.padEnd(48) + status;

    if (this.#options.isTty && !state.finished) {
      this.#options.write(`\r${line}`);
      this.#currentLineDirty = true;
    } else {
      this.#finishLine();
      this.#options.write(`${line}\n`);
    }
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
