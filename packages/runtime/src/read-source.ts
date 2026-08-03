import {
  type BuildScope,
  type CatalogArtifact,
  type CatalogNode,
  LoreError,
  RUNTIME_LIMITS,
  type SourceLocator,
  type SourceReadRequest,
} from '@lorepack/core';

/**
 * Reading an exact, cited range out of a sealed build.
 *
 * The whole point is that it works with the user's files deleted (architecture 11.2): the
 * normalized body lives in the object store and the node records carry the coordinates, so
 * a Worker with no filesystem answers this identically.
 *
 * **A range is resolved through nodes, never by slicing the body.** Line numbers on a node
 * address the *source*; the normalized body has its own numbering, because normalization
 * collapses blank runs. Measured on a four-node Markdown fixture, source line 13 is line 7
 * of the normalized body. Slicing the body by a source range returns the wrong text,
 * plausibly and silently, which is worse than failing, and it is the trap the Phase 1
 * audit caught before it was written (#44).
 */

export interface ReadSourceOutcome {
  readonly text: string;
  readonly truncated: boolean;
  readonly locator: SourceLocator;
}

export async function readSourceFrom(
  scope: BuildScope,
  request: SourceReadRequest,
): Promise<ReadSourceOutcome> {
  const artifact = await resolveArtifact(scope, request);
  const wantsRange =
    request.lineStart !== undefined ||
    request.lineEnd !== undefined ||
    (request.headingPath !== undefined && request.headingPath.length > 0);

  if (request.page !== undefined) {
    // Pages exist for PDFs, which arrive in Phase 5. Saying so is better than returning
    // page one of a Markdown file and letting a model cite it.
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'This build has no paginated artifacts.', {
      remediation: 'Page addressing arrives with the PDF parser. Use a line or heading range.',
      subject: artifact.displayPath,
    });
  }

  return wantsRange ? readRange(scope, artifact, request) : readWhole(scope, artifact);
}

/**
 * By artifact id or by canonical path, and by nothing else.
 *
 * Nothing here touches a filesystem: the request names something the build recorded, and
 * anything else is a miss. An absolute path or a traversal is therefore not dangerous so
 * much as meaningless, and it is refused with the bounds a caller can act on rather than
 * with a silent empty result (architecture 20.9).
 */
async function resolveArtifact(
  scope: BuildScope,
  request: SourceReadRequest,
): Promise<CatalogArtifact> {
  const wanted = request.artifactId ?? request.path ?? '';
  const artifact = await scope.catalog.artifact(wanted);
  if (artifact !== null) return artifact;

  // Reachable from MCP and REST, where the reader is a model with no shell, so the advice
  // has to be something it can act on from here. Search returns a locator, and a locator is
  // exactly the identifier this read wanted (#193).
  throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No artifact ${wanted} in this build.`, {
    remediation: 'Search for the document first: every result carries the path to read it by.',
    subject: wanted,
  });
}

async function readWhole(scope: BuildScope, artifact: CatalogArtifact): Promise<ReadSourceOutcome> {
  const body = await scope.objects.get(artifact.objectHash);
  if (body === null) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `The normalized body of ${artifact.displayPath} is missing from this build.`,
      {
        remediation: 'Run `lore build` to produce a complete build.',
        subject: artifact.objectHash,
      },
    );
  }

  const nodes = await scope.catalog.nodes(artifact.artifactId);
  const bounds = sourceBounds(nodes);
  const { text, truncated } = bound(new TextDecoder().decode(body));

  return {
    text,
    truncated,
    locator: {
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      ...(bounds === null ? {} : { lineStart: bounds.lineStart, lineEnd: bounds.lineEnd }),
    },
  };
}

async function readRange(
  scope: BuildScope,
  artifact: CatalogArtifact,
  request: SourceReadRequest,
): Promise<ReadSourceOutcome> {
  const nodes = await scope.catalog.nodes(artifact.artifactId);
  const bounds = sourceBounds(nodes);

  if (request.lineStart !== undefined && request.lineEnd !== undefined) {
    if (request.lineEnd < request.lineStart) {
      throw new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        `lineEnd ${request.lineEnd} is before lineStart ${request.lineStart}.`,
        { remediation: 'Pass a range that runs forwards.', subject: artifact.displayPath },
      );
    }
  }

  const selected = nodes.filter((node) => matches(node, request));
  if (selected.length === 0) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `Nothing in ${artifact.displayPath} matches that range.`,
      {
        remediation:
          bounds === null
            ? 'This artifact records no line numbers, so read it whole.'
            : `The artifact spans lines ${bounds.lineStart} to ${bounds.lineEnd}.`,
        subject: artifact.displayPath,
      },
    );
  }

  // Ordinal order, which is document order. Concatenating by score or by line number would
  // reorder a document whose nodes nest.
  const ordered = [...selected].sort((left, right) => left.ordinal - right.ordinal);
  const { text, truncated } = bound(ordered.map((node) => node.text).join('\n\n'));
  const span = sourceBounds(ordered);
  const headingPath = ordered[0]?.headingPath ?? [];

  return {
    text,
    truncated,
    // Echoed in source coordinates, which is what the caller asked in and what a citation
    // has to mean to a person opening the file.
    locator: {
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      ...(headingPath.length === 0 ? {} : { headingPath: [...headingPath] }),
      ...(span === null ? {} : { lineStart: span.lineStart, lineEnd: span.lineEnd }),
    },
  };
}

function matches(node: CatalogNode, request: SourceReadRequest): boolean {
  if (request.headingPath !== undefined && request.headingPath.length > 0) {
    const wanted = request.headingPath;
    const has =
      node.headingPath.length >= wanted.length &&
      wanted.every((heading, index) => node.headingPath[index] === heading);
    if (!has) return false;
  }

  if (request.lineStart === undefined && request.lineEnd === undefined) return node.text !== '';
  if (node.lineStart === null || node.lineEnd === null) return false;

  // Intersection, not containment: a range that starts mid-paragraph still wants that
  // paragraph, because a half-sentence is not a citable answer.
  const from = request.lineStart ?? 1;
  const to = request.lineEnd ?? Number.MAX_SAFE_INTEGER;
  return node.lineStart <= to && node.lineEnd >= from && node.text !== '';
}

function sourceBounds(
  nodes: readonly CatalogNode[],
): { lineStart: number; lineEnd: number } | null {
  const located = nodes.filter(
    (node) => node.lineStart !== null && node.lineEnd !== null && node.text !== '',
  );
  if (located.length === 0) return null;
  return {
    lineStart: Math.min(...located.map((node) => node.lineStart as number)),
    lineEnd: Math.max(...located.map((node) => node.lineEnd as number)),
  };
}

/** Truncation is a fact in the response, never a surprise in the text. */
function bound(text: string): { text: string; truncated: boolean } {
  const limit = RUNTIME_LIMITS.maxSourceReadCharacters;
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
