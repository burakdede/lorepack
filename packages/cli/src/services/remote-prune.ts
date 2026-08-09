import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LORE_DIRECTORY,
  LoreError,
  type RemoteRetentionReceipt,
  remoteRetentionReceiptSchema,
  writeFileAtomic,
} from '@lorepack/core';

export function remotePruneReceiptsDirectory(projectRoot: string): string {
  return join(projectRoot, LORE_DIRECTORY, 'receipts');
}

export function remotePruneReceiptPath(projectRoot: string, receiptId: string): string {
  return join(remotePruneReceiptsDirectory(projectRoot), `${receiptId}.json`);
}

export function readRemotePruneReceipt(
  projectRoot: string,
  receiptId: string,
): RemoteRetentionReceipt {
  const path = remotePruneReceiptPath(projectRoot, receiptId);
  if (!existsSync(path)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No remote cleanup receipt ${receiptId}.`, {
      remediation: 'Check the receipt id, or start the cleanup again from the beginning.',
      subject: receiptId,
    });
  }

  const parsed = remoteRetentionReceiptSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new LoreError(
      'LORE_E_BUILD_VALIDATION',
      `Remote cleanup receipt ${receiptId} is not readable.`,
      {
        remediation:
          'Start the cleanup again from the beginning. A receipt is a record, so losing one is safe.',
        subject: receiptId,
      },
    );
  }

  return parsed.data;
}

export function writeRemotePruneReceipt(
  projectRoot: string,
  receipt: RemoteRetentionReceipt,
): void {
  mkdirSync(remotePruneReceiptsDirectory(projectRoot), { recursive: true });
  writeFileAtomic(
    remotePruneReceiptPath(projectRoot, receipt.receiptId),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

export function remotePruneReceiptId(seed: string | null): string {
  return `cloudflare-prune-${seed === null ? 'none' : seed.slice(5, 17)}`;
}
