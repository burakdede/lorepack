import {
  CANONICALIZATION_VERSION,
  type Canonical,
  type ExecutionIdentity,
  type ExecutionPolicy,
  type ExecutionSelection,
  executionPolicySchema,
  executionSelectionSchema,
  hashCanonicalPortable,
  MAXIMUM_CONTEXT_RECEIPT_BYTES,
  NATIVE_UNIT_LIMITS,
  RANKING_WEIGHTS,
  RANKING_WEIGHTS_VERSION,
  type TaskContextRequest,
} from '@lorepack/core/worker';
import { MAX_ALTERNATIVES, MAX_ITEMS_PER_ARTIFACT, ORIENTATION_SHARE } from './assemble.js';
import {
  CONTEXT_BYTES_PER_TOKEN,
  MAXIMUM_CONTEXT_BYTES,
  MAXIMUM_OMISSION_DETAILS,
  MAXIMUM_PROJECT_NAME_LENGTH,
} from './budget.js';

export function resolveExecutionPolicy(input: {
  profile: ExecutionPolicy['packing']['profile'];
  budget: number;
  includeArchived: boolean;
  compilerVersion: string;
  receipt?: TaskContextRequest['receipt'];
}): ExecutionPolicy {
  return executionPolicySchema.parse({
    version: 1,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    retrieval: {
      version: 2,
      normalization: 'fts5-unicode61',
      queryVersion: 1,
      rankingVersion: 1,
      weightsVersion: RANKING_WEIGHTS_VERSION,
      weights: RANKING_WEIGHTS,
    },
    packing: {
      version: 4,
      profile: input.profile,
      budget: input.budget,
      orientationShare: ORIENTATION_SHARE,
      maximumItemsPerArtifact: MAX_ITEMS_PER_ARTIFACT,
      maximumAlternatives: MAX_ALTERNATIVES,
      maximumOmissionDetails: MAXIMUM_OMISSION_DETAILS,
      unit: 'native-unit',
      maximumNativeUnitBytes: NATIVE_UNIT_LIMITS.maxUtf8Bytes,
    },
    estimator: {
      version: 2,
      mode: 'serialized-utf8-estimate',
      bytesPerToken: CONTEXT_BYTES_PER_TOKEN,
      wordFloor: 'whitespace-words',
      compilerVersion: input.compilerVersion,
    },
    visibility: {
      version: 2,
      default: 'current-only',
      includeArchived: input.includeArchived,
      drafts: 'eligible-labeled-downranked',
    },
    serialization: {
      version: input.receipt !== undefined && input.receipt !== false ? 5 : 4,
      format: 'bounded-supported-formats',
      maximumBytes: MAXIMUM_CONTEXT_BYTES,
      maximumProjectNameLength: MAXIMUM_PROJECT_NAME_LENGTH,
      ...(input.receipt !== undefined && input.receipt !== false
        ? {
            receipt: {
              version: 1,
              maximumBytes: MAXIMUM_CONTEXT_RECEIPT_BYTES,
              captureRequest: typeof input.receipt === 'object' && input.receipt.captureRequest,
            },
          }
        : {}),
    },
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
