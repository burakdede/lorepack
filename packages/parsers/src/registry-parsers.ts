import type { ArtifactParser } from '@lorepack/core';
import { htmlParser } from './html/parser.js';
import { markdownParser } from './markdown/parser.js';
import { textParser } from './text/parser.js';

/**
 * Built-in parsers, registered explicitly. Architecture section 4.8: no dynamic discovery
 * in v0.1, so the set a build can use is visible in one place and reviewable in a diff.
 */
export const PARSERS: readonly ArtifactParser[] = [markdownParser, htmlParser, textParser];

export function parserFor(input: {
  mediaType: string;
  relativePath: string;
}): ArtifactParser | null {
  return PARSERS.find((parser) => parser.supports(input)) ?? null;
}
