/**
 * The shape of the catalog inside a sealed build.
 *
 * Split into its own module so Worker-safe consumers can read the schema constant without
 * importing the build-id derivation code, which depends on hashing helpers the Worker bundle
 * deliberately excludes.
 *
 * - 1: the original catalog (#15, #76).
 * - 2: `tables.cell_range`, so a table's locator carries the range the parser recorded (#235).
 * - 3: `chunks.page`, so a citation of a PDF names the page rather than a line it is not on
 *      (#241).
 */
export const SCHEMA_VERSION = 3 as const;
