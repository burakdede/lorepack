import { createHash } from 'node:crypto';
import {
  createContextReceipt,
  MAXIMUM_CONTEXT_RECEIPT_BYTES,
  verifyContextReceipt,
} from '@lorepack/core/worker';
import { expect, it } from 'vitest';
import { identifyExecution, resolveExecutionPolicy } from '../src/context/execution.js';

async function bundle(task = 'rollback private-customer') {
  const identity = {
    corpusId: `corpus_${'c'.repeat(32)}`,
    namespaceId: `namespace_${'d'.repeat(32)}`,
    buildId: `lore_${'a'.repeat(64)}`,
  };
  const execution = await identifyExecution(
    resolveExecutionPolicy({
      profile: 'agent',
      budget: 12000,
      includeArchived: false,
      compilerVersion: '0.1.0',
    }),
    { ...identity, task, filters: [] },
  );
  return { ...identity, execution };
}

const payload = '{"text":"café 🧭"}\n';

it('round-trips exact emitted UTF-8 bytes and preserves canonical receipt identity', async () => {
  const captured = await bundle();
  const receipt = await createContextReceipt({ bundle: captured, payload, format: 'json' });
  expect(receipt.payloadDigest).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(receipt.payloadBytes).toBe(Buffer.byteLength(payload));
  expect(
    await verifyContextReceipt(JSON.parse(JSON.stringify(receipt)), Buffer.from(payload)),
  ).toEqual(receipt);
  const reversed = Object.fromEntries(Object.entries(receipt).reverse());
  expect(await verifyContextReceipt(reversed, payload)).toEqual(receipt);
  expect(await createContextReceipt({ bundle: captured, payload, format: 'json' })).toEqual(
    receipt,
  );
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(
    MAXIMUM_CONTEXT_RECEIPT_BYTES,
  );
});

it('redacts request text by default and captures it only after explicit opt-in', async () => {
  const captured = await bundle();
  const ordinary = await createContextReceipt({ bundle: captured, payload, format: 'json' });
  expect(JSON.stringify(ordinary)).not.toContain('private-customer');
  expect(ordinary.requestRetained).toBe(false);
  expect(ordinary.payloadRetained).toBe(false);
  const retained = await createContextReceipt({
    bundle: captured,
    payload,
    format: 'json',
    captureRequest: true,
  });
  expect(retained.request).toEqual(captured.execution.selection);
  expect(retained.requestRetained).toBe(true);
  expect(retained.payloadRetained).toBe(false);
  expect(retained.requestDigest).toBe(ordinary.requestDigest);
  expect(retained.receiptId).not.toBe(ordinary.receiptId);
  expect(await verifyContextReceipt(retained, payload)).toEqual(retained);
});

it('distinguishes normalized requests, formats and emitted whitespace', async () => {
  const captured = await bundle();
  const first = await createContextReceipt({ bundle: captured, payload, format: 'json' });
  const request = await createContextReceipt({
    bundle: await bundle('a different task'),
    payload,
    format: 'json',
  });
  const markdown = await createContextReceipt({ bundle: captured, payload, format: 'markdown' });
  const trimmed = await createContextReceipt({
    bundle: captured,
    payload: payload.trimEnd(),
    format: 'json',
  });
  expect(request.requestDigest).not.toBe(first.requestDigest);
  expect(request.receiptId).not.toBe(first.receiptId);
  expect(markdown.receiptId).not.toBe(first.receiptId);
  expect(trimmed.payloadDigest).not.toBe(first.payloadDigest);
  expect(trimmed.receiptId).not.toBe(first.receiptId);
  await expect(verifyContextReceipt(first, payload.trimEnd())).rejects.toMatchObject({
    code: 'LORE_E_SCHEMA_MISMATCH',
  });
});

it.each([
  ['receiptVersion', 2],
  ['canonicalizationVersion', 2],
  ['buildId', `lore_${'b'.repeat(64)}`],
  ['boundary', 'model-received-content'],
  ['payloadFormat', 'markdown'],
  ['payloadBytes', 1],
  ['payloadDigest', 'b'.repeat(64)],
  ['requestDigest', 'b'.repeat(64)],
  ['receiptId', `context_receipt_${'b'.repeat(64)}`],
  ['payloadRetained', true],
  ['requestRetained', true],
  ['unknown', 'ignored'],
])('rejects corrupted or unsupported %s', async (field, value) => {
  const receipt = await createContextReceipt({ bundle: await bundle(), payload, format: 'json' });
  await expect(verifyContextReceipt({ ...receipt, [field]: value }, payload)).rejects.toMatchObject(
    { code: 'LORE_E_SCHEMA_MISMATCH' },
  );
});

it('rejects modified captured requests and execution policy fields', async () => {
  const receipt = await createContextReceipt({
    bundle: await bundle(),
    payload,
    format: 'json',
    captureRequest: true,
  });
  await expect(
    verifyContextReceipt(
      { ...receipt, request: { ...receipt.request, task: 'tampered' } },
      payload,
    ),
  ).rejects.toMatchObject({ code: 'LORE_E_SCHEMA_MISMATCH' });
  await expect(
    verifyContextReceipt(
      { ...receipt, execution: { ...receipt.execution, policyId: `policy_${'f'.repeat(64)}` } },
      payload,
    ),
  ).rejects.toMatchObject({ code: 'LORE_E_SCHEMA_MISMATCH' });
});

it('refuses an identity inconsistent with the captured build and oversized request capture', async () => {
  const captured = await bundle();
  await expect(
    createContextReceipt({
      bundle: { ...captured, buildId: `lore_${'b'.repeat(64)}` },
      payload,
      format: 'json',
    }),
  ).rejects.toMatchObject({ code: 'LORE_E_SCHEMA_MISMATCH' });
  await expect(
    createContextReceipt({
      bundle: await bundle('x'.repeat(4000)),
      payload,
      format: 'json',
      captureRequest: true,
    }),
  ).rejects.toMatchObject({ code: 'LORE_E_LIMIT_EXCEEDED' });
});
