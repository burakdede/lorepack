import { LoreError } from './errors/lore-error.js';
import {
  type Canonical,
  hashCanonicalPortable,
  sha256HexPortable,
} from './hash/canonical_value.js';
import {
  type ContextReceipt,
  contextReceiptSchema,
  MAXIMUM_CONTEXT_RECEIPT_BYTES,
} from './schemas/context_receipt.js';
import { executionIdentitySchema } from './schemas/execution.js';
import type { ContextBundle } from './schemas/runtime.js';

export async function createContextReceipt(options: {
  bundle: Pick<ContextBundle, 'buildId' | 'corpusId' | 'namespaceId' | 'execution'>;
  payload: string | Uint8Array;
  format: ContextReceipt['payloadFormat'];
  captureRequest?: boolean;
}): Promise<ContextReceipt> {
  const parsedExecution = executionIdentitySchema.safeParse(options.bundle.execution);
  if (!parsedExecution.success)
    throw invalidReceipt('Unsupported or malformed execution identity.');
  const execution = parsedExecution.data;
  await assertExecution(execution);
  const identity = {
    buildId: options.bundle.buildId,
    corpusId: options.bundle.corpusId,
    namespaceId: options.bundle.namespaceId,
  };
  if (
    Object.entries(identity).some(
      ([key, value]) => execution.selection[key as keyof typeof identity] !== value,
    )
  ) {
    throw invalidReceipt('The receipt build does not match the captured execution.');
  }
  const bytes = payloadBytes(options.payload);
  if (bytes.byteLength > execution.policy.serialization.maximumBytes) {
    throw invalidReceipt('The emitted payload exceeds its declared byte limit.');
  }
  const body = {
    receiptVersion: 1 as const,
    canonicalizationVersion: 1 as const,
    boundary: 'lorepack-emitted-content' as const,
    assurance: 'integrity-only' as const,
    ...identity,
    requestDigest: await requestDigest(execution.selection, execution.policy),
    requestRetained: options.captureRequest === true,
    ...(options.captureRequest === true ? { request: execution.selection } : {}),
    execution: {
      policyId: execution.policyId,
      selectionId: execution.selectionId,
      policy: execution.policy,
    },
    evidencePrecision: 'declared-per-item' as const,
    payloadFormat: options.format,
    payloadDigest: await sha256HexPortable(bytes),
    payloadBytes: bytes.byteLength,
    payloadRetained: false as const,
  };
  const receipt = contextReceiptSchema.parse({
    ...body,
    receiptId: await receiptId(body),
  });
  assertBounded(receipt);
  return receipt;
}

export async function verifyContextReceipt(
  unchecked: unknown,
  payload: string | Uint8Array,
): Promise<ContextReceipt> {
  const parsed = contextReceiptSchema.safeParse(unchecked);
  if (!parsed.success) throw invalidReceipt('Unsupported or malformed context receipt.');
  const receipt = parsed.data;
  assertBounded(receipt);
  await assertExecution({ ...receipt.execution, selection: receipt.request });
  const { receiptId: expectedId, ...body } = receipt;
  const bytes = payloadBytes(payload);
  if (
    expectedId !== (await receiptId(body)) ||
    bytes.byteLength !== receipt.payloadBytes ||
    receipt.payloadDigest !== (await sha256HexPortable(bytes)) ||
    (receipt.request !== undefined &&
      receipt.requestDigest !== (await requestDigest(receipt.request, receipt.execution.policy)))
  ) {
    throw invalidReceipt('The receipt or retained payload failed its integrity check.');
  }
  return receipt;
}

function payloadBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : Uint8Array.from(payload);
}

async function assertExecution(execution: {
  policyId: string;
  selectionId: string;
  policy: ContextReceipt['execution']['policy'];
  selection?: NonNullable<ContextReceipt['request']> | undefined;
}): Promise<void> {
  const policyId = `policy_${await hashCanonicalPortable({ domain: 'lorepack-execution-policy-v1', policy: execution.policy as Canonical })}`;
  if (
    policyId !== execution.policyId ||
    (execution.selection !== undefined &&
      execution.selectionId !==
        `selection_${await hashCanonicalPortable({ domain: 'lorepack-context-selection-v1', policyId, selection: execution.selection as Canonical })}`)
  ) {
    throw invalidReceipt('The receipt execution identity failed its integrity check.');
  }
}

async function receiptId(body: Omit<ContextReceipt, 'receiptId'>): Promise<string> {
  return `context_receipt_${await hashCanonicalPortable({ domain: 'lorepack-context-receipt-v1', receipt: body as Canonical })}`;
}

async function requestDigest(
  selection: NonNullable<ContextReceipt['request']>,
  policy: ContextReceipt['execution']['policy'],
): Promise<string> {
  return hashCanonicalPortable({
    domain: 'lorepack-context-request-v1',
    selection: selection as Canonical,
    policy: policy as Canonical,
  });
}

function assertBounded(receipt: ContextReceipt): void {
  if (
    new TextEncoder().encode(JSON.stringify(receipt)).byteLength > MAXIMUM_CONTEXT_RECEIPT_BYTES
  ) {
    throw new LoreError(
      'LORE_E_LIMIT_EXCEEDED',
      'The detached context receipt exceeds its byte limit.',
      {
        remediation: 'Disable request capture or shorten the task and filters.',
        details: { maximumBytes: MAXIMUM_CONTEXT_RECEIPT_BYTES },
      },
    );
  }
}

function invalidReceipt(message: string): LoreError {
  return new LoreError('LORE_E_SCHEMA_MISMATCH', message, {
    remediation:
      'Use a supported receipt and the exact saved payload bytes. A receipt cannot recover discarded content.',
  });
}
