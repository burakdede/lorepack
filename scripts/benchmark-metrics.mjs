export function countMetric(numerator, denominator) {
  if (!Number.isInteger(numerator) || numerator < 0)
    throw new Error('numerator must be non-negative');
  if (!Number.isInteger(denominator) || denominator < 0)
    throw new Error('denominator must be non-negative');
  if (numerator > denominator) throw new Error('numerator cannot exceed denominator');
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

export function isValidSourceLocator(locator) {
  if (locator === null || typeof locator !== 'object' || typeof locator.relativePath !== 'string')
    return false;
  return ['lineStart', 'lineEnd', 'page', 'sheet', 'cellRange'].some(
    (field) => locator[field] !== undefined && locator[field] !== null,
  );
}

export function provenanceCoverage(locators) {
  const valid = locators.filter(isValidSourceLocator).length;
  return { ...countMetric(valid, locators.length), invalid: locators.length - valid };
}

export function expectedLocationCoverage(cited, expected) {
  return countMetric(cited, expected);
}

export function contextBudgetFit(bundles) {
  const omittedByReason = {};
  let withinBudget = 0;
  let selectedTokens = 0;
  let omittedItems = 0;
  for (const bundle of bundles) {
    if (bundle.estimatedTokens <= bundle.budget) withinBudget += 1;
    selectedTokens += bundle.estimatedTokens;
    omittedItems += bundle.omitted.length;
    for (const item of bundle.omitted) {
      omittedByReason[item.reason] = (omittedByReason[item.reason] ?? 0) + 1;
    }
  }
  return {
    cases: bundles.length,
    withinBudget: countMetric(withinBudget, bundles.length),
    selectedTokens,
    omittedItems,
    omittedByReason,
  };
}

export function changeReviewWorkload({ added, changed, removed, warnings, contextDelta }) {
  return {
    added: countMetric(added, added + changed + removed),
    changed: countMetric(changed, added + changed + removed),
    removed: countMetric(removed, added + changed + removed),
    warnings,
    contextDelta,
  };
}

export function rollbackEvidence({
  pointerChangeMs,
  activeBuildId,
  expectedBuildId,
  rebuiltBuilds,
}) {
  return {
    pointerChangeMs,
    activeBuildId,
    expectedBuildId,
    restored: activeBuildId === expectedBuildId,
    rebuiltBuilds,
    rebuildAvoided: rebuiltBuilds === 0,
  };
}
