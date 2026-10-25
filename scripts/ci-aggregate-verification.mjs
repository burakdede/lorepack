export function selectedVerificationPassed({
  classifierResult,
  docsOnly,
  verifyResult,
  docsResult,
}) {
  if (classifierResult !== 'success') return false;
  return docsOnly === 'true' ? docsResult === 'success' : verifyResult === 'success';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const passed = selectedVerificationPassed({
    classifierResult: process.env.CLASSIFIER_RESULT,
    docsOnly: process.env.DOCS_ONLY,
    verifyResult: process.env.VERIFY_RESULT,
    docsResult: process.env.DOCS_RESULT,
  });

  if (!passed) {
    console.error('verification: the selected verification path did not pass');
    process.exitCode = 1;
  }
}
