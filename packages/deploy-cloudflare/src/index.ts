import { D1CatalogStore, type D1CatalogStoreOptions } from './catalog.js';
import {
  type ProjectArchiveUploadOptions,
  type ProjectArchiveUploadResult,
  uploadProjectArchive,
} from './project-archive.js';
import {
  type ProjectObjectUploadOptions,
  type ProjectObjectUploadResult,
  uploadProjectObjects,
} from './project-objects.js';
import type {
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
} from './projection-migrations.js';
import { runProjectionMigrations } from './projection-migrations.js';
import { r2ArchiveKey, r2ObjectKey } from './r2-keys.js';
import {
  createRuntimeTokenAuthorizer,
  hashRuntimeToken,
  hasRuntimeToken,
  listRuntimeTokens,
  rotateRuntimeTokenHash,
  RUNTIME_TOKEN_OVERLAP_MS,
  RUNTIME_TOKEN_PREFIX,
  RUNTIME_TOKENS_TABLE,
  type RuntimeTokenRecord,
  type RuntimeAuthDatabaseLike,
  revokeRuntimeTokens,
  storeRuntimeTokenHash,
} from './runtime-auth.js';
import { D1ActiveBuildProvider, type R2BucketLike, R2ObjectStore } from './storage.js';
import { D1TableStore } from './tables.js';
import {
  CloudflareApplyError,
  type CloudflareDeploymentTargetOptions,
  createCloudflareDeploymentTarget,
} from './target.js';

export type {
  CloudflareBindings,
  CloudflareBoundWorkerOptions,
  CloudflareRuntimeOptions,
  CloudflareWorkerApp,
  D1CatalogDatabaseLike,
  D1CatalogNamespace,
  D1DatabaseLike,
  D1QueryDatabaseLike,
  D1TableNamespace,
} from './worker-app.js';
export {
  createCloudflareWorker,
  createCloudflareWorkerApp,
  createCloudflareWorkerFromBindings,
} from './worker-app.js';

export type {
  CloudflareDeploymentTargetOptions,
  D1CatalogStoreOptions,
  ProjectArchiveUploadOptions,
  ProjectArchiveUploadResult,
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
  ProjectObjectUploadOptions,
  ProjectObjectUploadResult,
  R2BucketLike,
  RuntimeAuthDatabaseLike,
  RuntimeTokenRecord,
};
export {
  CloudflareApplyError,
  createCloudflareDeploymentTarget,
  createRuntimeTokenAuthorizer,
  D1ActiveBuildProvider,
  D1CatalogStore,
  D1TableStore as D1NamespacedTableStore,
  D1TableStore,
  hashRuntimeToken,
  hasRuntimeToken,
  listRuntimeTokens,
  R2ObjectStore,
  rotateRuntimeTokenHash,
  RUNTIME_TOKEN_OVERLAP_MS,
  RUNTIME_TOKEN_PREFIX,
  RUNTIME_TOKENS_TABLE,
  r2ArchiveKey,
  r2ObjectKey,
  revokeRuntimeTokens,
  runProjectionMigrations,
  storeRuntimeTokenHash,
  uploadProjectArchive,
  uploadProjectObjects,
};
