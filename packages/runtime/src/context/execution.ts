import {
  CANONICALIZATION_VERSION,
  type Canonical,
  type ExecutionIdentity,
  type ExecutionPolicy,
  type ExecutionSelection,
  executionPolicySchema,
  executionSelectionSchema,
  hashCanonicalPortable,
  RANKING_WEIGHTS,
  RANKING_WEIGHTS_VERSION,
} from '@lorepack/core/worker';
import { MAX_ALTERNATIVES, MAX_ITEMS_PER_ARTIFACT, ORIENTATION_SHARE } from './assemble.js';

export function resolveExecutionPolicy(input: {
  profile: ExecutionPolicy['packing']['profile'];
  budget: number;
  includeArchived: boolean;
  compilerVersion: string;
}): ExecutionPolicy {
  return executionPolicySchema.parse({
    version: 1,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    retrieval: {
      version: 1,
      normalization: 'fts5-unicode61',
      queryVersion: 1,
      rankingVersion: 1,
      weightsVersion: RANKING_WEIGHTS_VERSION,
      weights: RANKING_WEIGHTS,
    },
    packing: {
      version: 1,
      profile: input.profile,
      budget: input.budget,
      orientationShare: ORIENTATION_SHARE,
      maximumItemsPerArtifact: MAX_ITEMS_PER_ARTIFACT,
      maximumAlternatives: MAX_ALTERNATIVES,
      unit: 'whole-chunk',
    },
    estimator: {
      version: 1,
      mode: 'stored-chunk-estimates',
      compilerVersion: input.compilerVersion,
    },
    visibility: {
      version: 1,
      default: 'current-preferred-with-historical-fallback',
      includeArchived: input.includeArchived,
      drafts: 'eligible-labeled-downranked',
    },
    serialization: { version: 1, format: 'context-bundle-json' },
  });
}

export async function identifyExecution(
  uncheckedPolicy: ExecutionPolicy,
  uncheckedSelection: ExecutionSelection,
): Promise<ExecutionIdentity> {
  const policy = executionPolicySchema.parse(uncheckedPolicy);
  const selection = executionSelectionSchema.parse(uncheckedSelection);
  selection.filters = [
    ...new Map(
      selection.filters.map((filter) => [`${filter.kind}:${filter.value}`, filter]),
    ).values(),
  ].sort((left, right) => {
    const a = `${left.kind}:${left.value}`;
    const b = `${right.kind}:${right.value}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const policyId = `policy_${await hashCanonicalPortable({ domain: 'lorepack-execution-policy-v1', policy: policy as Canonical })}`;
  const selectionId = `selection_${await hashCanonicalPortable({ domain: 'lorepack-context-selection-v1', policyId, selection: selection as Canonical })}`;
  return { version: 1, policyId, selectionId, policy, selection };
}
