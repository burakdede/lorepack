/**
 * Stages emit typed events; renderers subscribe. The compiler never writes to a console,
 * which is what lets the same run drive a TTY, a CI log, and a test collector.
 */

export type StageName =
  | 'discovering'
  | 'fingerprinting'
  | 'parsing'
  | 'normalizing'
  | 'importing-tables'
  | 'resolving-rules'
  | 'chunking'
  | 'indexing'
  | 'validating'
  | 'sealing'
  | 'activating'
  | 'projecting'
  | 'uploading'
  | 'verifying';

export interface StageStarted {
  readonly type: 'stage-started';
  readonly stage: StageName;
  readonly label: string;
  readonly total?: number;
  readonly at: number;
}

export interface StageProgress {
  readonly type: 'stage-progress';
  readonly stage: StageName;
  /** Measurable work done. A spinner without this is not acceptable progress. */
  readonly completed: number;
  readonly total?: number;
  readonly unit?: string;
  readonly detail?: string;
  readonly at: number;
}

export interface StageFinished {
  readonly type: 'stage-finished';
  readonly stage: StageName;
  readonly completed: number;
  readonly outcome: 'done' | 'skipped' | 'failed';
  readonly at: number;
}

export interface DiagnosticEvent {
  readonly type: 'diagnostic';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly at: number;
}

export type ProgressEvent = StageStarted | StageProgress | StageFinished | DiagnosticEvent;

export type ProgressListener = (event: ProgressEvent) => void;

export class ProgressBus {
  #listeners = new Set<ProgressListener>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  subscribe(listener: ProgressListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: ProgressEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  start(stage: StageName, label: string, total?: number): void {
    this.emit({
      type: 'stage-started',
      stage,
      label,
      ...(total === undefined ? {} : { total }),
      at: this.#now(),
    });
  }

  progress(stage: StageName, completed: number, extra: Partial<StageProgress> = {}): void {
    this.emit({ ...extra, type: 'stage-progress', stage, completed, at: this.#now() });
  }

  finish(stage: StageName, completed: number, outcome: StageFinished['outcome'] = 'done'): void {
    this.emit({ type: 'stage-finished', stage, completed, outcome, at: this.#now() });
  }

  diagnostic(level: DiagnosticEvent['level'], message: string): void {
    this.emit({ type: 'diagnostic', level, message, at: this.#now() });
  }
}
