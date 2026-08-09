import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';
import { withProgressHeartbeat } from './upload-progress.js';

export interface ProjectionBatchProgress {
  readonly completedBatches: number;
  readonly totalBatches: number;
  readonly detail: string;
}

export interface ProjectionWriteOptions {
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
  readonly progressIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (update: ProjectionBatchProgress) => void;
}

export function projectionWriteOptions(options: {
  readonly retryAttempts?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly progressIntervalMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly onProgress?: ((update: ProjectionBatchProgress) => void) | undefined;
}): ProjectionWriteOptions {
  return {
    ...(options.retryAttempts === undefined ? {} : { retryAttempts: options.retryAttempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.progressIntervalMs === undefined
      ? {}
      : { progressIntervalMs: options.progressIntervalMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  };
}

interface ProjectionWriteState {
  completedBatches: number;
  readonly totalBatches: number;
}

interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export function createProjectionWriteState(totalBatches: number): ProjectionWriteState {
  return { completedBatches: 0, totalBatches };
}

export async function runProjectionBatch(
  db: ProjectionMigrationDatabaseLike,
  query: string,
  bindings: readonly unknown[],
  options: ProjectionWriteOptions,
  state: ProjectionWriteState,
  detail: string,
): Promise<void> {
  await withProjectionRetries(async () => {
    await withProgressHeartbeat(
      options.progressIntervalMs ?? 1000,
      () => {
        options.onProgress?.({
          completedBatches: state.completedBatches,
          totalBatches: state.totalBatches,
          detail,
        });
      },
      async () => {
        await db
          .prepare(query)
          .bind(...bindings)
          .run();
      },
    );
  }, options);
  state.completedBatches += 1;
  options.onProgress?.({
    completedBatches: state.completedBatches,
    totalBatches: state.totalBatches,
    detail,
  });
}

export async function withProjectionRetries<T>(
  action: () => Promise<T>,
  options: Pick<ProjectionWriteOptions, 'retryAttempts' | 'retryDelayMs' | 'sleep'>,
): Promise<T> {
  const policy = retryPolicy(options);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= policy.attempts || !isTransientProjectionError(error)) throw error;
      await policy.sleep(policy.delayMs * attempt);
    }
  }
}

function retryPolicy(
  options: Pick<ProjectionWriteOptions, 'retryAttempts' | 'retryDelayMs' | 'sleep'>,
): RetryPolicy {
  return {
    attempts: options.retryAttempts ?? 3,
    delayMs: options.retryDelayMs ?? 250,
    sleep: options.sleep ?? defaultSleep,
  };
}

function isTransientProjectionError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes('database is locked') ||
    message.includes('database is busy') ||
    message.includes('busy') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('temporarily unavailable')
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return String(error).toLowerCase();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
