import type { ContextBundle, ContextReceipt } from './contracts.js';

export async function verifyHttpReceipt(
  header: string | null,
  payload: string,
  bundle: ContextBundle,
  captureRequest: boolean,
): Promise<ContextReceipt> {
  if (header === null || header.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(header))
    throw new Error('Invalid receipt header');
  const encoded = header.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes.byteLength > 4096) throw new Error('Receipt exceeds its byte limit');
  const actual: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const payloadBytes = new TextEncoder().encode(payload).byteLength;
  const { policy, selection, policyId, selectionId } = bundle.execution;
  if (
    payloadBytes > 4 * 1024 * 1024 ||
    payloadBytes > policy.serialization.maximumBytes ||
    bundle.execution.version !== 1 ||
    policy.canonicalizationVersion !== 1 ||
    selection.buildId !== bundle.buildId ||
    selection.corpusId !== bundle.corpusId ||
    selection.namespaceId !== bundle.namespaceId ||
    policy.serialization.receipt?.version !== 1 ||
    policy.serialization.receipt.maximumBytes !== 4096 ||
    policy.serialization.receipt.captureRequest !== captureRequest ||
    policyId !== `policy_${await hash({ domain: 'lorepack-execution-policy-v1', policy })}` ||
    selectionId !==
      `selection_${await hash({ domain: 'lorepack-context-selection-v1', policyId, selection })}`
  )
    throw new Error('Invalid execution identity');
  const body: Omit<ContextReceipt, 'receiptId'> = {
    receiptVersion: 1,
    canonicalizationVersion: 1,
    boundary: 'lorepack-emitted-content',
    assurance: 'integrity-only',
    buildId: bundle.buildId,
    corpusId: bundle.corpusId,
    namespaceId: bundle.namespaceId,
    requestDigest: await hash({ domain: 'lorepack-context-request-v1', selection, policy }),
    requestRetained: captureRequest,
    ...(captureRequest ? { request: selection } : {}),
    execution: { policyId, selectionId, policy },
    evidencePrecision: 'declared-per-item',
    payloadFormat: 'json',
    payloadDigest: await sha256(payload),
    payloadBytes,
    payloadRetained: false,
  };
  const expected: ContextReceipt = {
    ...body,
    receiptId: `context_receipt_${await hash({ domain: 'lorepack-context-receipt-v1', receipt: body })}`,
  };
  if (canonicalize(actual) !== canonicalize(expected))
    throw new Error('Receipt integrity mismatch');
  return expected;
}

async function hash(value: unknown): Promise<string> {
  return sha256(canonicalize(value));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalize(value: unknown): string {
  if (value === null) return 'n';
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (typeof value === 'boolean') return value ? 'b1' : 'b0';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = Number.isInteger(value) ? String(value) : value.toPrecision(17);
    return `i${text.length}:${text}`;
  }
  if (Array.isArray(value)) return `a${value.length}:${value.map(canonicalize).join('')}`;
  if (typeof value !== 'object' || value === undefined) throw new Error('Invalid canonical value');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `o${keys.length}:${keys.map((key) => canonicalize(key) + canonicalize(record[key])).join('')}`;
}
