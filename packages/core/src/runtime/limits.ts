/**
 * Bounds that apply when serving a build, not when compiling one.
 *
 * Deliberately separate from `PRODUCT_DEFAULTS.limits`. Those are compilation inputs: they
 * are part of the effective configuration, so they are hashed into the build id, and
 * adding a field to them would change the identity of every build in existence. How much
 * text one read may return decides nothing about what a build contains, so it does not
 * belong anywhere near that hash.
 */
export const RUNTIME_LIMITS = {
  /**
   * The largest normalized text a single `readSource` returns. Beyond it the result is
   * truncated and says so: a model must never receive a silently clipped document
   * (architecture 13.1).
   */
  maxSourceReadCharacters: 200_000,
} as const;
