/**
 * The candidate a user probably meant, or nothing.
 *
 * Levenshtein rather than a prefix match, because the mistakes people actually make are
 * transpositions and a dropped letter, and a prefix match catches neither.
 *
 * Returning `null` past a threshold is the important part. A wrong suggestion is worse than
 * no suggestion: it sends the reader to change something they never meant to touch, and it
 * reads as confident because it is specific.
 */
export function closestMatch(
  candidate: string,
  known: readonly string[],
  maximumDistance = 3,
): string | null {
  let best: { value: string; distance: number } | null = null;
  for (const value of known) {
    const distance = editDistance(candidate.toLowerCase(), value.toLowerCase());
    if (best === null || distance < best.distance) best = { value, distance };
  }
  return best !== null && best.distance <= maximumDistance ? best.value : null;
}

/** Levenshtein distance, used only to suggest what someone probably meant. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current.push(Math.min(deletion, insertion, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
