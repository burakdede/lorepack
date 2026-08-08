import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ActivationReceipt,
  type BuildId,
  buildManifestSchema,
  type Capability,
  count,
  type DeployApplyReporter,
  type DeploymentReceipt,
  type DeploymentTarget,
  type DeployPlan,
  type DeployPlanDisplay,
  LoreError,
  type TargetCapabilities,
  type TargetDetection,
  type VerificationResult,
} from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { type D1CatalogDatabaseLike, D1CatalogStore } from './catalog.js';
import { uploadProjectArchive } from './project-archive.js';
import { projectBuildMetadata } from './project-metadata.js';
import { uploadProjectObjects } from './project-objects.js';
import {
  D1_FREE_TIER_LIMIT_BYTES,
  D1_FREE_TIER_WARN_BYTES,
  preflightProjection,
  type ProjectionPreflightResult,
} from './projection-preflight.js';
import { projectSearchData } from './project-search-data.js';
import { projectTableData } from './project-table-data.js';
import {
  type ProjectionMigrationDatabaseLike,
  runProjectionMigrations,
} from './projection-migrations.js';
import { assertProjectionReadable } from './projection-state.js';
import { r2ArchiveKey } from './r2-keys.js';
import { type D1DatabaseLike, type R2BucketLike, R2ObjectStore } from './storage.js';
import { type D1QueryDatabaseLike, D1TableStore } from './tables.js';

const DEFAULT_CAPABILITIES = ['lexical-search', 'structured-context', 'table-query'] as const;

export interface CloudflareDeploymentTargetOptions {
  readonly projectId: string;
  readonly endpoint: string;
  readonly workerName?: string;
  readonly catalogDatabaseName?: string;
  readonly objectsBucketName?: string;
  readonly catalogDb: ProjectionMigrationDatabaseLike &
    D1CatalogDatabaseLike &
    D1QueryDatabaseLike &
    D1DatabaseLike;
  readonly objects: R2BucketLike;
  readonly now?: () => string;
  readonly detect?: () => Promise<TargetDetection>;
  readonly capabilities?: () => Promise<TargetCapabilities>;
  readonly verifyCandidate?: (receipt: DeploymentReceipt) => Promise<VerificationResult>;
  readonly activateCandidate?: (receipt: DeploymentReceipt) => Promise<ActivationReceipt>;
  readonly publicBuildId?: () => Promise<BuildId | null>;
  readonly rollbackBuild?: (buildId: DeploymentReceipt['buildId']) => Promise<ActivationReceipt>;
  readonly preflight?: (buildDirectory: string) => ProjectionPreflightResult;
}

export class CloudflareApplyError extends LoreError {
  readonly receipt: DeploymentReceipt;

  constructor(message: string, receipt: DeploymentReceipt, cause: unknown) {
    super('LORE_E_REMOTE_DEPLOY', message, {
      remediation: 'Deploy again with --resume so the completed candidate work is reused.',
      details: { receiptId: receipt.receiptId },
      cause,
    });
    this.receipt = receipt;
  }
}

export function createCloudflareDeploymentTarget(
  options: CloudflareDeploymentTargetOptions,
): DeploymentTarget {
  return {
    id: 'cloudflare',
    detect: async () =>
      (await options.detect?.()) ?? {
        installed: true,
        version: 'phase-6-fixture',
      },
    capabilities: async () =>
      (await options.capabilities?.()) ?? {
        supported: [...DEFAULT_CAPABILITIES] as Capability[],
        endpoint: options.endpoint,
      },
    plan: async (input): Promise<DeployPlan> => {
      const capabilities = await ((await options.capabilities?.()) ?? {
        supported: [...DEFAULT_CAPABILITIES] as Capability[],
        endpoint: options.endpoint,
      });
      const currentBuildId = await readCurrentPublicBuildId(options.publicBuildId);
      const preflight = (options.preflight ?? preflightProjection)(input.buildDirectory);
      return {
        target: 'cloudflare',
        input,
        capabilityLoss: input.buildCapabilities.filter(
          (capability) => !capabilities.supported.includes(capability),
        ),
        steps: [
          'run D1 projection migrations',
          'project build metadata',
          'project search data',
          'project table data',
          'upload build archive',
          'upload normalized objects',
        ],
        endpoint: options.endpoint,
        transfer: {
          archive: { key: r2ArchiveKey(options.projectId, input.buildId) },
          objects: {
            referenced: countReferencedObjects(input.buildDirectory),
            uploaded: 0,
            skipped: 0,
            verified: 0,
          },
          state: {
            migrations_done: false,
            metadata_done: false,
            search_done: false,
            tables_done: false,
            archive_done: false,
            objects_done: false,
          },
        },
        display: await renderDisplay({
          options,
          input,
          currentBuildId,
          preflight,
        }),
      };
    },
    apply: async (plan, resume, progress): Promise<DeploymentReceipt> => {
      let receipt = receiptFor(plan, resume);
      let transfer = normalizeTransfer(receipt.transfer, plan);
      const buildDirectory = plan.input.buildDirectory;
      const objectsDirectory = join(dirname(dirname(buildDirectory)), 'objects');
      let projectedSteps = countCompletedProjectionSteps(transfer);
      let uploadedBytes = transfer.archive?.sizeBytes ?? 0;
      let uploadTotalBytes = uploadedBytes;

      try {
        if (transfer.state?.migrations_done !== true) {
          await runProjectionMigrations(options.catalogDb, options.now);
          transfer = updateState(transfer, 'migrations_done', true);
          receipt = { ...receipt, transfer };
          projectedSteps += 1;
          reportProjectionProgress(progress, projectedSteps, 'migrations');
        }

        if (transfer.state?.metadata_done !== true) {
          await projectBuildMetadata({
            db: options.catalogDb,
            projectId: options.projectId,
            buildDirectory,
            ...(options.now === undefined ? {} : { projectedAt: options.now() }),
          });
          transfer = updateState(transfer, 'metadata_done', true);
          receipt = { ...receipt, transfer };
          projectedSteps += 1;
          reportProjectionProgress(progress, projectedSteps, 'metadata');
        }

        if (transfer.state?.search_done !== true) {
          await projectSearchData({
            db: options.catalogDb,
            projectId: options.projectId,
            buildId: plan.input.buildId,
            buildDirectory,
          });
          transfer = updateState(transfer, 'search_done', true);
          receipt = { ...receipt, transfer };
          projectedSteps += 1;
          reportProjectionProgress(progress, projectedSteps, 'search');
        }

        if (transfer.state?.tables_done !== true) {
          await projectTableData({
            db: options.catalogDb,
            projectId: options.projectId,
            buildId: plan.input.buildId,
            buildDirectory,
          });
          transfer = updateState(transfer, 'tables_done', true);
          receipt = { ...receipt, transfer };
          projectedSteps += 1;
          reportProjectionProgress(progress, projectedSteps, 'tables');
        }

        if (transfer.state?.archive_done !== true) {
          const archive = await uploadProjectArchive({
            bucket: options.objects,
            projectId: options.projectId,
            buildId: plan.input.buildId,
            buildDirectory,
            objectsDirectory,
            onProgress: (update) => {
              uploadedBytes = update.completedBytes;
              uploadTotalBytes = Math.max(uploadTotalBytes, update.totalBytes);
              progress?.({
                stage: 'uploading',
                completed: uploadedBytes,
                total: uploadTotalBytes,
                unit: 'bytes',
                detail: update.detail,
              });
            },
          });
          transfer = updateState(
            {
              ...transfer,
              archive: {
                key: archive.key,
                sha256: archive.sha256,
                sizeBytes: archive.sizeBytes,
              },
            },
            'archive_done',
            true,
          );
          receipt = { ...receipt, transfer };
        }

        if (transfer.state?.objects_done !== true) {
          const objects = await uploadProjectObjects({
            bucket: options.objects,
            projectId: options.projectId,
            buildDirectory,
            objectsDirectory,
            onProgress: (update) => {
              uploadTotalBytes = Math.max(
                uploadTotalBytes,
                (transfer.archive?.sizeBytes ?? 0) + update.totalBytes,
              );
              uploadedBytes = (transfer.archive?.sizeBytes ?? 0) + update.completedBytes;
              progress?.({
                stage: 'uploading',
                completed: uploadedBytes,
                total: uploadTotalBytes,
                unit: 'bytes',
                detail: `${update.completedObjects}/${update.totalObjects} objects, ${update.uploadedObjects} uploaded, ${update.skippedObjects} skipped`,
              });
            },
          });
          transfer = updateState(
            {
              ...transfer,
              objects: {
                referenced: objects.referencedObjects,
                uploaded: objects.uploadedObjects,
                skipped: objects.skippedObjects,
                verified: objects.verifiedObjects,
              },
            },
            'objects_done',
            true,
          );
          receipt = { ...receipt, transfer };
        }

        return receipt;
      } catch (cause) {
        throw new CloudflareApplyError(
          `The cloudflare target failed while projecting candidate ${plan.input.buildId}.`,
          receipt,
          cause,
        );
      }
    },
    verify: async (receipt) => {
      if (options.verifyCandidate !== undefined) return await options.verifyCandidate(receipt);
      return await verifyCandidateBuild(options, receipt);
    },
    activate: async (receipt) => {
      if (options.activateCandidate !== undefined) return await options.activateCandidate(receipt);
      return await activateCandidateBuild(options, receipt);
    },
    rollback: async (buildId) => {
      if (options.rollbackBuild !== undefined) return await options.rollbackBuild(buildId);
      return await rollbackProjectedBuild(options, buildId);
    },
  };
}

function reportProjectionProgress(
  progress: DeployApplyReporter | undefined,
  completed: number,
  detail: string,
): void {
  progress?.({
    stage: 'projecting',
    completed,
    total: 4,
    unit: 'steps',
    detail,
  });
}

function countCompletedProjectionSteps(
  transfer: NonNullable<DeploymentReceipt['transfer']>,
): number {
  return [
    transfer.state?.migrations_done === true,
    transfer.state?.metadata_done === true,
    transfer.state?.search_done === true,
    transfer.state?.tables_done === true,
  ].filter(Boolean).length;
}

function receiptFor(plan: DeployPlan, resume?: DeploymentReceipt): DeploymentReceipt {
  return (
    resume ?? {
      formatVersion: 1,
      receiptId: `cloudflare-${plan.input.buildId.slice(5, 17)}`,
      target: 'cloudflare',
      project: plan.input.projectName,
      buildId: plan.input.buildId,
      previousBuildId: null,
      state: 'projecting',
      deployedAt: new Date().toISOString(),
      endpoint: plan.endpoint,
      capabilityLossAccepted: [],
      completedSteps: ['plan'],
      ...(plan.transfer === undefined ? {} : { transfer: plan.transfer }),
      verification: { search: 'skipped', sourceRead: 'skipped', tableQuery: 'skipped' },
    }
  );
}

function normalizeTransfer(
  receiptTransfer: DeploymentReceipt['transfer'],
  plan: DeployPlan,
): NonNullable<DeploymentReceipt['transfer']> {
  return (
    receiptTransfer ??
    plan.transfer ?? {
      state: {},
    }
  );
}

function updateState(
  transfer: NonNullable<DeploymentReceipt['transfer']>,
  key: string,
  value: string | number | boolean | null,
): NonNullable<DeploymentReceipt['transfer']> {
  return {
    ...transfer,
    state: {
      ...(transfer.state ?? {}),
      [key]: value,
    },
  };
}

function countReferencedObjects(buildDirectory: string): number {
  const db = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    const rows = db
      .prepare('SELECT DISTINCT object_hash FROM artifacts ORDER BY object_hash')
      .all() as Array<Record<string, unknown>>;
    return rows.length;
  } finally {
    db.close();
  }
}

async function renderDisplay(input: {
  readonly options: CloudflareDeploymentTargetOptions;
  readonly input: DeployPlan['input'];
  readonly currentBuildId: BuildId | null | undefined;
  readonly preflight: ProjectionPreflightResult;
}): Promise<DeployPlanDisplay> {
  const manifest = buildManifestSchema.parse(
    JSON.parse(readFileSync(join(input.input.buildDirectory, 'manifest.json'), 'utf8')),
  );
  const compared = await compareProjectedArtifacts(
    input.options.catalogDb,
    input.options.projectId,
    input.input.buildDirectory,
    input.currentBuildId,
  );
  const projectionLines = [
    `+ ${count(compared.added, 'artifact')}`,
    `~ ${count(compared.changed, 'artifact')}`,
    `= ${count(compared.reused, 'artifact')} reused by content hash`,
    `+ ${count(manifest.counts.chunks, 'chunk')}`,
    `+ ${count(manifest.counts.tableRows, 'table row')}`,
    `~ about ${input.preflight.estimatedProjectedBytes.toLocaleString('en-US')} projected D1 bytes`,
  ];
  if (input.preflight.estimatedProjectedBytes >= D1_FREE_TIER_WARN_BYTES) {
    projectionLines.push(
      `! approaches Cloudflare D1's free-tier ${D1_FREE_TIER_LIMIT_BYTES.toLocaleString('en-US')} byte limit`,
    );
    for (const contributor of input.preflight.largestContributors) {
      projectionLines.push(
        `! ${contributor.relativePath}: about ${contributor.bytes.toLocaleString('en-US')} bytes`,
      );
    }
  }

  return {
    targetLabel: 'cloudflare / personal',
    resourceLines: [
      `= Worker ${input.options.workerName ?? '(resolved by receipt)'}`,
      `= D1 ${input.options.catalogDatabaseName ?? '(resolved by receipt)'}`,
      `= R2 ${input.options.objectsBucketName ?? '(resolved by receipt)'}`,
    ],
    projectionLines,
    activationLines: [
      `current ${input.currentBuildId ?? 'none'}`,
      `next    ${input.input.buildId}`,
    ],
  };
}

async function compareProjectedArtifacts(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  buildDirectory: string,
  currentBuildId: BuildId | null | undefined,
): Promise<{ readonly added: number; readonly changed: number; readonly reused: number }> {
  const candidate = readCandidateArtifactHashes(buildDirectory);
  if (currentBuildId === undefined || currentBuildId === null) {
    return { added: candidate.size, changed: 0, reused: 0 };
  }
  const current = await readProjectedArtifactHashes(db, projectId, currentBuildId);
  let added = 0;
  let changed = 0;
  let reused = 0;
  for (const [artifactId, contentHash] of candidate) {
    const previous = current.get(artifactId);
    if (previous === undefined) {
      added += 1;
      continue;
    }
    if (previous === contentHash) {
      reused += 1;
      continue;
    }
    changed += 1;
  }
  return { added, changed, reused };
}

function readCandidateArtifactHashes(buildDirectory: string): ReadonlyMap<string, string> {
  const db = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    const rows = db
      .prepare('SELECT id, content_hash AS contentHash FROM artifacts ORDER BY id')
      .all() as Array<{
      readonly id: string;
      readonly contentHash: string;
    }>;
    return new Map(rows.map((row) => [row.id, row.contentHash]));
  } finally {
    db.close();
  }
}

async function readProjectedArtifactHashes(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  buildId: BuildId,
): Promise<ReadonlyMap<string, string>> {
  try {
    const rows = await db
      .prepare(
        'SELECT id, content_hash AS contentHash FROM artifacts WHERE project_id = ? AND build_id = ? ORDER BY id',
      )
      .bind(projectId, buildId)
      .run<{ readonly id: string; readonly contentHash: string }>();
    return new Map((rows.results ?? []).map((row) => [row.id, row.contentHash]));
  } catch {
    return new Map();
  }
}

async function readCurrentPublicBuildId(
  publicBuildId: CloudflareDeploymentTargetOptions['publicBuildId'],
): Promise<BuildId | null | undefined> {
  if (publicBuildId === undefined) return undefined;
  try {
    return await publicBuildId();
  } catch {
    return undefined;
  }
}

async function verifyCandidateBuild(
  options: CloudflareDeploymentTargetOptions,
  receipt: DeploymentReceipt,
): Promise<VerificationResult> {
  const buildId = receipt.buildId as BuildId;
  await assertProjectionReadable(options.catalogDb, { projectId: options.projectId, buildId });

  const catalog = new D1CatalogStore({
    db: options.catalogDb,
    namespace: { projectId: options.projectId, buildId },
  });

  const runtime = createRuntime({
    provider: {
      async current() {
        return { buildId, generation: 0 };
      },
      async acquire() {
        return { buildId, generation: 0, release() {} };
      },
    },
    open: async () => ({
      buildId,
      catalog,
      tables: new D1TableStore(options.catalogDb, { projectId: options.projectId, buildId }),
      objects: new R2ObjectStore(options.projectId, options.objects),
    }),
  });

  const build = await runtime.describeBuild();
  const capabilities = [...build.capabilities];
  const failures: string[] = [];

  let search: VerificationResult['search'] = 'skipped';
  let sourceRead: VerificationResult['sourceRead'] = 'skipped';
  let tableQuery: VerificationResult['tableQuery'] = 'skipped';

  const smokeQuery = await candidateSmokeQuery(catalog);
  const artifact =
    smokeQuery === null
      ? undefined
      : (
          await runtime.search({
            query: smokeQuery,
            limit: 1,
            includeArchived: false,
            debug: false,
          })
        ).hits[0];
  if (smokeQuery === null || artifact === undefined) {
    search = 'failed';
    failures.push('candidate search returned no hits');
  } else {
    search = 'passed';
    try {
      await runtime.readSource({ artifactId: artifact.artifactId });
      sourceRead = 'passed';
    } catch (cause) {
      sourceRead = 'failed';
      failures.push(`candidate source read failed: ${LoreError.from(cause).message}`);
    }
  }

  try {
    const tables = await runtime.listTables();
    if (tables.length === 0) {
      tableQuery = 'skipped';
    } else {
      const firstTable = tables[0];
      if (firstTable === undefined) {
        tableQuery = 'skipped';
      } else {
        const description = await runtime.describeTable(firstTable.tableId);
        const firstColumn = description.columns[0]?.sqlName;
        if (firstColumn === undefined) {
          tableQuery = 'skipped';
        } else {
          await runtime.queryTable({
            tableId: description.tableId,
            sql: `SELECT ${firstColumn} FROM ${description.sqlName} LIMIT 1`,
            limit: 1,
          });
          tableQuery = 'passed';
        }
      }
    }
  } catch (cause) {
    tableQuery = 'failed';
    failures.push(`candidate table query failed: ${LoreError.from(cause).message}`);
  }

  return {
    search,
    sourceRead,
    tableQuery,
    capabilities,
    ...(failures.length === 0 ? {} : { failures }),
  };
}

async function activateCandidateBuild(
  options: CloudflareDeploymentTargetOptions,
  receipt: DeploymentReceipt,
): Promise<ActivationReceipt> {
  return await switchActiveBuild(options, receipt.buildId as BuildId);
}

async function rollbackProjectedBuild(
  options: CloudflareDeploymentTargetOptions,
  buildId: BuildId,
): Promise<ActivationReceipt> {
  await assertProjectionReadable(options.catalogDb, { projectId: options.projectId, buildId });
  return await switchActiveBuild(options, buildId);
}

async function switchActiveBuild(
  options: CloudflareDeploymentTargetOptions,
  buildId: BuildId,
): Promise<ActivationReceipt> {
  let previous: { readonly buildId: BuildId; readonly generation: number } | null = null;
  try {
    await options.catalogDb.prepare('BEGIN IMMEDIATE').run();
    previous = await currentActiveBuild(options.catalogDb);
    if (previous?.buildId !== buildId) {
      const nextGeneration = (previous?.generation ?? 0) + 1;
      await options.catalogDb
        .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
        .bind(buildId, nextGeneration)
        .run();
    }
    await options.catalogDb.prepare('COMMIT').run();
  } catch (cause) {
    try {
      await options.catalogDb.prepare('ROLLBACK').run();
    } catch {}
    throw new LoreError(
      'LORE_E_REMOTE_DEPLOY',
      `Could not switch the active cloudflare build to ${buildId}.`,
      {
        remediation:
          'Nothing was switched publicly. Retry once the D1 catalog is writable and the projected build is complete.',
        subject: buildId,
        cause,
      },
    );
  }

  const confirmedBuildId =
    options.publicBuildId === undefined ? null : await options.publicBuildId();
  return {
    buildId,
    previousBuildId: previous?.buildId ?? null,
    confirmedBuildId,
    endpoint: options.endpoint,
  };
}

function smokeQueryFor(projectName: string): string {
  const words = projectName
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length >= 3);
  return words[0] ?? 'rollback';
}

async function candidateSmokeQuery(catalog: D1CatalogStore): Promise<string | null> {
  const artifact = (await catalog.artifacts())[0];
  if (artifact === undefined) return null;
  const node = (await catalog.nodes(artifact.artifactId)).find(
    (candidate) => candidate.text.trim() !== '',
  );
  const words = (node?.text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length >= 4);
  return words[0] ?? smokeQueryFor(artifact.relativePath);
}

async function currentActiveBuild(
  db: ProjectionMigrationDatabaseLike,
): Promise<{ readonly buildId: BuildId; readonly generation: number } | null> {
  const rows = await db
    .prepare('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1')
    .run<{ buildId: string | null; generation: number }>();
  const row = rows.results?.[0];
  if (row === undefined || row.buildId === null) return null;
  return { buildId: row.buildId as BuildId, generation: Number(row.generation) };
}
