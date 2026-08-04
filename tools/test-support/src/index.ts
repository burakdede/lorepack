export {
  checkDeterminism,
  type DeterminismOptions,
  type DeterminismReport,
} from './determinism.js';
export { makeDocx, paragraph, table, trackedChange } from './docx-fixtures.js';
export {
  canonicalJson,
  compareGolden,
  describeFirstDifference,
  FIXTURES_ROOT,
  type GoldenResult,
  goldenPathFor,
  updateMode,
} from './golden.js';
export {
  boolean_,
  empty,
  errorCell,
  formula,
  inlineString,
  makeXlsx,
  number,
  row,
  type SheetSpec,
  shared,
  type WorkbookSpec,
} from './office-fixtures.js';
export { makeEncryptedPdf, makePdf, type PageSpec } from './pdf-fixtures.js';
export {
  type ContractFixture,
  type ContractOptions,
  runRuntimeContract,
} from './runtime-contract.js';
export { type TempProject, type TempProjectOptions, withTempProject } from './temp-project.js';
