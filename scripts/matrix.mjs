import { createPlan, REQUIRED_CHECKS } from './profiles.mjs';

export { REQUIRED_CHECKS };
export const MATRIX = createPlan('baseline').cells;
const BUILD_ID = /^[A-Za-z0-9._-]{1,128}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const text = value => typeof value === 'string' && value.length > 0;
const sameSet = (left, right) => Array.isArray(left) && left.length === right.length &&
  new Set(left).size === left.length && right.every(item => left.includes(item));

export function runtimeIssue(runtime, expected) {
  if (!runtime || runtime.os?.platform !== expected.os || !text(runtime.os?.release) || !text(runtime.os?.version)) return 'RUNNER_ENVIRONMENT_MISMATCH';
  if (runtime.arch?.host !== expected.arch || runtime.arch?.node !== expected.arch) return 'RUNNER_ARCHITECTURE_MISMATCH';
  if (runtime.arch?.browser !== expected.arch || !text(runtime.arch?.browserEvidence) || runtime.arch.browserEvidence === 'unknown') return 'BROWSER_ARCHITECTURE_MISMATCH';
  const engine = expected.browser === 'webkit' ? 'webkit' : 'chromium';
  if (runtime.browser?.name !== engine || runtime.browser?.channel !== expected.browser || !text(runtime.browser?.version)) return 'BROWSER_IDENTITY_MISMATCH';
  const release = expected.release;
  const actualVersion = runtime.os.version;
  const actualProduct = String(runtime.os.product || '').toLowerCase();
  if (release.mode === 'exact' && actualVersion !== release.version) return 'RUNNER_OS_VERSION_MISMATCH';
  if (release.mode === 'major' && actualVersion.split('.')[0] !== release.version) return 'RUNNER_OS_VERSION_MISMATCH';
  if (release.product && !actualProduct.includes(release.product.toLowerCase())) return 'RUNNER_OS_PRODUCT_MISMATCH';
  if (release.build && !actualVersion.split('.').includes(release.build)) return 'RUNNER_OS_VERSION_MISMATCH';
  return null;
}

function contextMatches(value, expected, request) {
  return value?.cellId === expected.id && value.profileId === request.profileId &&
    value.requestedSuite === request.suite && value.suite === expected.suite &&
    value.harnessCommit === request.harnessCommit && value.expectedHarnessCommit === request.harnessCommit &&
    value.runId === request.runId && value.runAttempt === request.runAttempt;
}

export function evaluateMatrix(input, request = {}, reportReadErrors = 0) {
  const cells = Array.isArray(input) ? input : [];
  let plan;
  try { plan = createPlan(request.profileId, request.suite); }
  catch (error) {
    return { schemaVersion: 2, status: 'failed', matrixIssue: error.message, rows: [], identityVerified: false };
  }
  const requestIssue = !BUILD_ID.test(request.expectedBuildId || '') ? 'EXPECTED_BUILD_ID_REQUIRED' :
    !COMMIT.test(request.harnessCommit || '') ? 'HARNESS_ID_REQUIRED' :
    !/^\d+$/.test(request.runId || '') || !/^[1-9]\d*$/.test(request.runAttempt || '') ? 'WORKFLOW_ID_INVALID' : null;
  const expectedIds = new Set(plan.cells.map(cell => cell.id));
  const counts = new Map();
  for (const cell of cells) counts.set(cell?.cellId, (counts.get(cell?.cellId) || 0) + 1);
  const duplicate = [...counts.values()].some(count => count > 1);
  const unexpected = cells.some(cell => !expectedIds.has(cell?.cellId));
  const byId = new Map(cells.map(cell => [cell?.cellId, cell]));
  const rows = plan.cells.map(expected => {
    const cell = byId.get(expected.id);
    if (!cell) return { ...expected, status: 'missing', code: 'CELL_REPORT_MISSING', validationIssues: ['CELL_REPORT_MISSING'], buildId: null, identityVerified: false, tests: [] };
    const tests = Array.isArray(cell.tests) ? cell.tests : [];
    const checkIds = tests.map(test => test?.checkId);
    const checksComplete = sameSet(checkIds, expected.checks) && sameSet(cell.requiredChecks, expected.checks);
    const testsPassed = checksComplete && tests.every(test => test?.status === 'passed' && !test.failure);
    const modelScopeMatches = cell.modelScope === expected.modelScope && cell.modelScopeReason === expected.modelScopeReason;
    const modelChecksComplete = tests.every(test => test?.checkId === 'core-models'
      ? test.diagnostics?.models?.attempted === true && test.diagnostics?.models?.completed === true
      : test?.checkId === 'media-smoke' && test.diagnostics?.models?.attempted === false && test.diagnostics?.models?.completed === false);
    const contextVerified = !requestIssue && contextMatches(cell, expected, request) &&
      tests.every(test => contextMatches(test?.diagnostics?.reportContext, expected, request));
    const buildVerified = !requestIssue && cell.buildId === request.expectedBuildId &&
      cell.expectedBuildId === request.expectedBuildId && cell.identityVerified === true &&
      tests.length > 0 && tests.every(test => test?.diagnostics?.buildId === request.expectedBuildId && test?.diagnostics?.identityVerified === true);
    const environmentIssue = cell.environment?.runner !== expected.runner ? 'RUNNER_ENVIRONMENT_MISMATCH' :
      runtimeIssue(cell.environment, expected) || tests.map(test => runtimeIssue(test?.diagnostics?.runtimeEnvironment, expected)).find(Boolean);
    const frameworkValid = Array.isArray(cell.frameworkErrors) && cell.frameworkErrors.length === 0;
    const errorsAbsent = !cell.failureCode && frameworkValid;
    const identityVerified = contextVerified && buildVerified;
    const validationIssues = [
      cell.schemaVersion !== 2 ? 'REPORT_SCHEMA_INVALID' : null,
      !contextVerified ? 'REPORT_IDENTITY_MISMATCH' : null,
      !buildVerified ? 'BUILD_ID_MISMATCH' : null,
      environmentIssue || null,
      !checksComplete ? 'EXPECTED_TESTS_NOT_PASSED' : null,
      !modelScopeMatches ? 'MODEL_SCOPE_MISMATCH' : null,
      !modelChecksComplete ? 'MODEL_RESULT_INVALID' : null,
      !errorsAbsent ? (cell.failureCode || cell.frameworkErrors?.[0]?.code || 'FRAMEWORK_ERROR') : null,
      !testsPassed ? (tests.find(test => test?.status !== 'passed')?.failure?.code || 'EXPECTED_TESTS_NOT_PASSED') : null,
      cell.status !== 'passed' ? 'CELL_NOT_PASSED' : null,
    ].filter(Boolean);
    const passed = validationIssues.length === 0;
    const runFailure = cell.failureCode || tests.find(test => test?.status !== 'passed')?.failure?.code || cell.frameworkErrors?.[0]?.code;
    return {
      ...expected, status: passed ? 'passed' : cell.status === 'passed' ? 'incomplete' : cell.status || 'invalid',
      code: passed ? null : runFailure || validationIssues[0], validationIssues: [...new Set(validationIssues)],
      buildId: cell.buildId || null, identityVerified,
      durationMs: cell.durationMs ?? null, tests, environment: cell.environment || {},
      harnessCommit: cell.harnessCommit || null, runId: cell.runId || null, runAttempt: cell.runAttempt || null,
    };
  });
  const buildIds = new Set(rows.map(row => row.buildId).filter(Boolean));
  const issue = requestIssue || (reportReadErrors > 0 ? 'CELL_REPORT_UNREADABLE' : null) ||
    (duplicate ? 'DUPLICATE_CELL_REPORT' : null) || (unexpected ? 'UNEXPECTED_CELL_REPORT' : null) ||
    (rows.some(row => row.status === 'missing') ? 'CELL_REPORT_MISSING' : null) ||
    (buildIds.size > 1 ? 'BUILD_ID_CHANGED_DURING_RUN' : null) ||
    (rows.some(row => !row.identityVerified) ? 'EXPECTED_IDENTITIES_NOT_VERIFIED' : null) ||
    (rows.some(row => row.status !== 'passed') ? 'EXPECTED_CELLS_NOT_PASSED' : null);
  return {
    schemaVersion: 2, profileId: plan.profileId, requestedSuite: plan.requestedSuite,
    expectedBuildId: request.expectedBuildId || null, harnessCommit: request.harnessCommit || null,
    runId: request.runId || null, runAttempt: request.runAttempt || null,
    expectedCells: plan.expectedCells, expectedSmokeChecks: plan.expectedSmokeChecks, expectedModelChecks: plan.expectedModelChecks,
    reportedCells: cells.length, reportReadErrors,
    status: issue === null ? 'passed' : 'failed',
    buildId: buildIds.size === 1 ? [...buildIds][0] : null,
    identityVerified: !requestIssue && rows.every(row => row.identityVerified),
    matrixIssue: issue, rows,
  };
}
