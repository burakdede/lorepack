/**
 * Counted nouns, in one place.
 *
 * Every renderer had been writing `${n} artifacts`, so the CLI regularly said things like
 * "parse 1 artifacts", "1 chunks" and "Removing 1 builds". Individually trivial; together
 * they are the difference between output that reads as written and output that reads as
 * generated (#150).
 *
 * English plurals are irregular enough that guessing is a mistake, so this does not try:
 * pass the plural when it is not the singular plus `s`.
 */
export function count(total: number, singular: string, plural?: string): string {
  return `${total.toLocaleString('en-US')} ${noun(total, singular, plural)}`;
}

/** The noun alone, for sentences that place the number somewhere else. */
export function noun(total: number, singular: string, plural?: string): string {
  return total === 1 ? singular : (plural ?? `${singular}s`);
}
