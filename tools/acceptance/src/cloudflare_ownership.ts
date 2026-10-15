export interface CloudflareOwnershipScope {
  readonly accountId: string;
  readonly testPrefix: string;
  readonly runId: string | null;
  readonly runAttempt: string | null;
}

export interface CloudflareOwnershipRecord extends CloudflareOwnershipScope {
  readonly formatVersion: 1;
  readonly projectName: string;
}

export const OWNERSHIP_KEY_PREFIX = 'ownership/v1/';

export function readCloudflareOwnershipRecord(
  value: unknown,
  scope: Pick<CloudflareOwnershipScope, 'accountId' | 'testPrefix'>,
): CloudflareOwnershipRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Cloudflare acceptance ownership record must be an object.');
  }
  const record = value as Record<string, unknown>;
  const numericOrNull = (input: unknown): input is string | null =>
    input === null || (typeof input === 'string' && /^[0-9]+$/.test(input));
  if (
    record.formatVersion !== 1 ||
    record.accountId !== scope.accountId ||
    record.testPrefix !== scope.testPrefix ||
    typeof record.projectName !== 'string' ||
    !/^lpci-[a-f0-9]{32}$/.test(record.projectName) ||
    !numericOrNull(record.runId) ||
    !numericOrNull(record.runAttempt) ||
    (record.runId === null) !== (record.runAttempt === null)
  ) {
    throw new Error('Cloudflare acceptance ownership record does not match its account or scope.');
  }
  return {
    formatVersion: 1,
    accountId: scope.accountId,
    testPrefix: scope.testPrefix,
    projectName: record.projectName,
    runId: record.runId,
    runAttempt: record.runAttempt,
  };
}

export function cloudflareOwnershipKey(record: CloudflareOwnershipRecord): string {
  return `${OWNERSHIP_KEY_PREFIX}${record.projectName}.json`;
}

export function cloudflareOwnershipNames(record: CloudflareOwnershipRecord): {
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly tablesDatabaseName: string;
  readonly objectsBucketName: string;
} {
  return {
    workerName: `${record.projectName}-runtime`,
    catalogDatabaseName: `${record.projectName}-catalog`,
    tablesDatabaseName: `${record.projectName}-tables`,
    objectsBucketName: `${record.projectName}-objects`,
  };
}

export function staleCloudflareOwnershipRecords(
  records: readonly CloudflareOwnershipRecord[],
  scope: CloudflareOwnershipScope,
): readonly CloudflareOwnershipRecord[] {
  if (scope.runId === null || scope.runAttempt === null) return [];
  if (!/^[0-9]+$/.test(scope.runId) || !/^[0-9]+$/.test(scope.runAttempt)) {
    throw new Error('Cloudflare acceptance cleanup requires numeric CI run metadata.');
  }
  const currentRun = BigInt(scope.runId);
  const currentAttempt = BigInt(scope.runAttempt);
  return records
    .map((record) => readCloudflareOwnershipRecord(record, scope))
    .filter((record) => {
      if (record.runId === null || record.runAttempt === null) return false;
      const run = BigInt(record.runId);
      return run < currentRun || (run === currentRun && BigInt(record.runAttempt) < currentAttempt);
    });
}
