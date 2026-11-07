export const MATRIX = [
  { id: 'mac-intel-chrome', runner: 'macos-15-intel', os: 'darwin', browser: 'chrome', arch: 'x64' },
  { id: 'mac-intel-webkit', runner: 'macos-15-intel', os: 'darwin', browser: 'webkit', arch: 'x64' },
  { id: 'mac-arm64-chrome', runner: 'macos-15', os: 'darwin', browser: 'chrome', arch: 'arm64' },
  { id: 'mac-arm64-webkit', runner: 'macos-15', os: 'darwin', browser: 'webkit', arch: 'arm64' },
  { id: 'windows-chrome', runner: 'windows-2025', os: 'win32', browser: 'chrome', arch: 'x64' },
  { id: 'windows-edge', runner: 'windows-2025', os: 'win32', browser: 'msedge', arch: 'x64' },
];
export const REQUIRED_CHECKS = {
  smoke: ['media-smoke'],
  models: ['media-smoke', 'core-models'],
};

export function evaluateMatrix(cells, suite = 'smoke', requestedBuildId = null) {
  const expectedIdValid = typeof requestedBuildId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(requestedBuildId);
  const requestedChecks = REQUIRED_CHECKS[suite];
  const byId = new Map(cells.map(cell => [cell.cellId, cell]));
  const duplicate = MATRIX.some(expected => cells.filter(cell => cell.cellId === expected.id).length > 1);
  const rows = MATRIX.map(expected => {
    const cell = byId.get(expected.id);
    if (!cell) return { ...expected, status: 'missing', code: 'CELL_REPORT_MISSING', buildId: null, identityVerified: false };
    const tests = Array.isArray(cell.tests) ? cell.tests : [];
    const checkIds = tests.map(test => test.checkId);
    const checksComplete = requestedChecks && tests.length === requestedChecks.length &&
      new Set(checkIds).size === checkIds.length &&
      requestedChecks.every(checkId => checkIds.includes(checkId));
    const testsPassed = checksComplete && tests.every(test => test.status === 'passed' && !test.failure);
    const environmentMatches = cell.environment?.os === expected.os &&
      cell.environment?.arch === expected.arch &&
      cell.environment?.browser === expected.browser &&
      cell.environment?.runner === expected.runner;
    const identityMatches = expectedIdValid && cell.buildId === requestedBuildId &&
      cell.expectedBuildId === requestedBuildId && cell.identityVerified === true &&
      tests.length > 0 && tests.every(test =>
        test.diagnostics?.buildId === requestedBuildId && test.diagnostics?.identityVerified === true);
    const errorsAbsent = !cell.failureCode && Array.isArray(cell.frameworkErrors) && cell.frameworkErrors.length === 0;
    const passed = cell.status === 'passed' && testsPassed && environmentMatches &&
      identityMatches && errorsAbsent && cell.suite === suite;
    const code = !environmentMatches ? 'RUNNER_ENVIRONMENT_MISMATCH' :
      !identityMatches ? 'BUILD_ID_MISMATCH' :
      !errorsAbsent ? (cell.failureCode || cell.frameworkErrors?.[0]?.code || 'FRAMEWORK_ERROR') :
      (!testsPassed || cell.suite !== suite) ? (tests.find(test => test.status !== 'passed')?.failure?.code || 'EXPECTED_TESTS_NOT_PASSED') :
      cell.status !== 'passed' ? 'CELL_NOT_PASSED' : null;
    return {
      ...expected, status: passed ? 'passed' : cell.status === 'passed' ? 'incomplete' : cell.status,
      code, buildId: cell.buildId || null, identityVerified: Boolean(identityMatches),
      durationMs: cell.durationMs ?? null, tests, environment: cell.environment || {},
    };
  });
  const buildIds = new Set(rows.map(row => row.buildId).filter(Boolean));
  const runIds = new Set(cells.map(cell => String(cell.runId) + ':' + String(cell.runAttempt)));
  const issue = !expectedIdValid ? 'EXPECTED_BUILD_ID_REQUIRED' : !requestedChecks ? 'SUITE_INVALID' :
    duplicate ? 'DUPLICATE_CELL_REPORT' : runIds.size > 1 ? 'MIXED_WORKFLOW_REPORTS' :
    rows.some(row => !row.buildId) ? 'BUILD_ID_MISSING' :
    buildIds.size !== 1 ? 'BUILD_ID_CHANGED_DURING_RUN' :
    rows.some(row => !row.identityVerified) ? 'EXPECTED_BUILD_NOT_VERIFIED' : null;
  return {
    schemaVersion: 1, suite, expectedBuildId: expectedIdValid ? requestedBuildId : null,
    status: rows.every(row => row.status === 'passed') && issue === null ? 'passed' : 'failed',
    buildId: buildIds.size === 1 ? [...buildIds][0] : null,
    identityVerified: rows.every(row => row.identityVerified),
    matrixIssue: issue, rows,
  };
}
