import { type SourceLocator, sourceLocatorSchema } from '../schemas/common.js';
import type { Artifact, LoreNode } from './nodes.js';

export interface LocatorBounds {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly lineEnd?: number;
  readonly pages?: number;
  readonly sheets: ReadonlyMap<string, string | undefined>;
}

export function locatorBounds(
  artifact: Pick<Artifact, 'id' | 'relativePath' | 'metadata'>,
  nodes: readonly Pick<LoreNode, 'kind' | 'locator' | 'metadata'>[],
): LocatorBounds {
  const root = nodes.find((node) => node.kind === 'document');
  return {
    artifactId: artifact.id,
    relativePath: artifact.relativePath,
    ...(root?.locator.lineEnd === undefined ? {} : { lineEnd: root.locator.lineEnd }),
    ...(typeof artifact.metadata.pages === 'number' ? { pages: artifact.metadata.pages } : {}),
    sheets: new Map(
      nodes
        .filter((node) => node.kind === 'sheet')
        .flatMap((node) => {
          const name = node.metadata.sheet ?? node.locator.sheet;
          if (typeof name !== 'string') return [];
          const extent =
            typeof node.metadata.cellRange === 'string' ? node.metadata.cellRange : undefined;
          return [[name, extent] as const];
        }),
    ),
  };
}

function cells(value: string): readonly [number, number, number, number] | undefined {
  const match = /^\$?([A-Z]+)\$?([1-9][0-9]*)(?::\$?([A-Z]+)\$?([1-9][0-9]*))?$/.exec(value);
  if (match === null || match[1] === undefined) return undefined;
  const column = (text: string): number =>
    [...text].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const first = column(match[1]);
  const last = column(match[3] ?? match[1]);
  const top = Number(match[2]);
  const bottom = Number(match[4] ?? match[2]);
  if (![first, last, top, bottom].every(Number.isSafeInteger) || first > last || top > bottom)
    return undefined;
  return [first, top, last, bottom];
}

export function locatorProblem(locator: SourceLocator, bounds: LocatorBounds): string | undefined {
  if (!sourceLocatorSchema.safeParse(locator).success)
    return 'The source locator has invalid coordinates.';
  if (locator.artifactId !== bounds.artifactId || locator.relativePath !== bounds.relativePath)
    return 'The source locator belongs to another artifact or path.';
  if (
    locator.lineStart !== undefined &&
    locator.lineEnd !== undefined &&
    locator.lineStart > locator.lineEnd
  )
    return 'The source line range is reversed.';
  const lineEnd = bounds.lineEnd;
  if (
    lineEnd !== undefined &&
    [locator.lineStart, locator.lineEnd].some((line) => line !== undefined && line > lineEnd)
  )
    return 'The source line range exceeds the recorded document extent.';
  if (locator.page !== undefined && bounds.pages !== undefined && locator.page > bounds.pages)
    return 'The source page exceeds the recorded page count.';
  if (locator.sheet !== undefined && !bounds.sheets.has(locator.sheet))
    return 'The source sheet is absent from the recorded artifact.';
  if (locator.cellRange !== undefined) {
    const range = cells(locator.cellRange);
    if (range === undefined) return 'The source cell range is invalid or reversed.';
    const extent = locator.sheet === undefined ? undefined : bounds.sheets.get(locator.sheet);
    if (extent !== undefined) {
      const region = cells(extent);
      if (
        region === undefined ||
        range[0] < region[0] ||
        range[1] < region[1] ||
        range[2] > region[2] ||
        range[3] > region[3]
      )
        return 'The source cell range exceeds the recorded sheet extent.';
    }
  }
  return undefined;
}
