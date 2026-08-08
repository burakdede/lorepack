/**
 * The Worker-safe subset of `@lorepack/core`.
 *
 * The full package barrel re-exports Node-only modules such as `./config` and `./fs`, which
 * is correct for CLI and compiler consumers and wrong for a Cloudflare Worker bundle. This
 * entrypoint exposes the runtime-facing types, schemas, ranking constants, and hashing
 * helpers that the Worker path actually needs, without dragging Node-only modules into the
 * graph by accident.
 */

export {
  ERROR_CODES,
  type ErrorCode,
  EXIT_CODES,
  type ExitCode,
  exitCodeFor,
} from './errors/codes.js';
export { causeChain, LoreError, type LoreErrorOptions } from './errors/lore-error.js';
export { REDACTED, redact, redactDeep, secretsFromEnv } from './errors/redact.js';
export {
  type JsonError,
  type RenderOptions,
  renderAsJson,
  renderForCli,
  renderForProtocol,
  stripAbsolutePaths,
} from './errors/render.js';
export { count, noun } from './format/count.js';
export {
  assertBuildId,
  BUILD_ID_PREFIX,
  type BuildId,
  DEFAULT_DISPLAY_LENGTH,
  formatBuildId,
  isBuildId,
  resolveBuildIdPrefix,
} from './hash/id.js';
export type { ColumnTypeName } from './model/nodes.js';
export { DEPLOY_STEPS } from './ports/deploy.js';
export type * from './ports/index.js';
export {
  bm25ColumnWeights,
  candidateCount,
  RANKING_WEIGHTS,
  RANKING_WEIGHTS_VERSION,
} from './ranking/weights.js';
export { RUNTIME_LIMITS } from './runtime/limits.js';
export * from './schemas/index.js';
