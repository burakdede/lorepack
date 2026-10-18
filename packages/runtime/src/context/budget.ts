import { type ContextBundle, LoreError } from '@lorepack/core/worker';
import { createBundleMarkdownRenderer, moreCommandFor, renderBundleMarkdown } from './render.js';
import { toolResult } from './serialize.js';

export const MAXIMUM_CONTEXT_BYTES = 4 * 1024 * 1024;
export const MAXIMUM_PROJECT_NAME_LENGTH = 100;
export const MAXIMUM_OMISSION_DETAILS = 20;
export const CONTEXT_BYTES_PER_TOKEN = 3.6;

export function omissionSummary(
  omitted: ContextBundle['omitted'],
  reported = omitted.length,
): ContextBundle['omissionSummary'] {
  const reasons = {
    budget: 0,
    duplicate: 0,
    diversity: 0,
    superseded: 0,
    archived: 0,
    filtered: 0,
    'structural-unit': 0,
  };
  for (const item of omitted) reasons[item.reason] += 1;
  return { total: omitted.length, reported, truncated: reported < omitted.length, reasons };
}

export function estimateDeliveredTokens(text: string): number {
  return Math.max(
    Math.ceil(new TextEncoder().encode(text).byteLength / CONTEXT_BYTES_PER_TOKEN),
    text.trim().split(/\s+/).filter(Boolean).length,
  );
}

export function measureContextRepresentations(bundle: ContextBundle): {
  estimatedTokens: number;
  bytes: number;
} {
  return measureRepresentations(bundle, renderBundleMarkdown);
}

function measureRepresentations(
  bundle: ContextBundle,
  renderMarkdown: typeof renderBundleMarkdown,
): { estimatedTokens: number; bytes: number } {
  const mcp = {
    ...toolResult(bundle),
    ...(bundle.execution.policy.serialization.receipt === undefined
      ? {}
      : {
          _meta: {
            'lorepack.dev/context-receipt': 'x'.repeat(
              bundle.execution.policy.serialization.receipt.maximumBytes,
            ),
          },
        }),
  };
  const representations = [
    `${JSON.stringify(bundle, null, 2)}\n`,
    JSON.stringify(bundle),
    JSON.stringify(mcp),
    renderMarkdown(bundle, {
      projectName: 'x'.repeat(MAXIMUM_PROJECT_NAME_LENGTH),
      moreCommand: moreCommandFor(bundle.task),
      sourceState: bundle.sourceState,
    }),
  ];
  return {
    estimatedTokens: Math.max(...representations.map(estimateDeliveredTokens)),
    bytes: Math.max(...representations.map((text) => new TextEncoder().encode(text).byteLength)),
  };
}

export function fitDeliveredContext(input: ContextBundle): ContextBundle {
  const renderMarkdown = createBundleMarkdownRenderer();
  const overview = [...input.overview];
  const selected = [...input.selected];
  const alternatives = [...input.alternatives];
  const allOmitted = [...input.omitted];
  let detailCount = Math.min(MAXIMUM_OMISSION_DETAILS, allOmitted.length);

  for (;;) {
    const bundle: ContextBundle = {
      ...input,
      overview: [...overview],
      selected: [...selected],
      alternatives: [...alternatives],
      citations: [...overview, ...selected].map((item) => item.locator),
      reservedTokens: overview.reduce((sum, item) => sum + item.estimatedTokens, 0),
      omitted: allOmitted.slice(0, detailCount),
      omissionSummary: omissionSummary(allOmitted, detailCount),
      estimatedTokens: 0,
    };
    let measured = measureRepresentations(bundle, renderMarkdown);
    while (measured.estimatedTokens > bundle.estimatedTokens) {
      bundle.estimatedTokens = measured.estimatedTokens;
      measured = measureRepresentations(bundle, renderMarkdown);
    }
    if (bundle.estimatedTokens <= bundle.budget && measured.bytes <= MAXIMUM_CONTEXT_BYTES) {
      return bundle;
    }
    if (detailCount > 0) {
      detailCount -= 1;
      continue;
    }
    const removed = alternatives.pop() ?? selected.pop() ?? overview.pop();
    if (removed !== undefined) {
      allOmitted.push({
        chunkId: removed.chunkId,
        reason: 'budget',
        ...(removed.nativeUnit === undefined
          ? {}
          : {
              nativeUnit: { nodeIds: [...removed.nativeUnit.nodeIds], status: 'omitted' as const },
            }),
        estimatedTokens: removed.estimatedTokens,
        locator: removed.locator,
      });
      continue;
    }
    throw new LoreError(
      'LORE_E_LIMIT_EXCEEDED',
      'Mandatory context framing does not fit the delivery limits.',
      {
        remediation:
          'Shorten the task or filters, or request a larger supported budget. The byte ceiling cannot be overridden.',
        details: {
          reason: 'context-framing-too-large',
          budget: input.budget,
          maximumBytes: MAXIMUM_CONTEXT_BYTES,
        },
      },
    );
  }
}
