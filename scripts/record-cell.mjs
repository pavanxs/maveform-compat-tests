import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeCellReport } from './cell-report.mjs';
import { safeBuildId, safeLabel, runtimeForReport, PUBLIC_ERROR_CODES } from './report-utils.mjs';
import { createPlan, REQUIRED_CHECKS } from './profiles.mjs';
import { collectReportContext } from './report-context.mjs';
import { collectRuntimeEnvironment } from './runtime-environment.mjs';

const context = collectReportContext();
let planned = null;
try { planned = createPlan(context.profileId, context.requestedSuite).cells.find(cell => cell.id === context.cellId); } catch {}
const reportPath = path.resolve('reports/public', context.cellId + '.json');
const stages = [
  ['checkout', 'COMPAT_CHECKOUT_OUTCOME'], ['node-setup', 'COMPAT_NODE_OUTCOME'],
  ['target', 'COMPAT_TARGET_OUTCOME'], ['dependencies', 'COMPAT_DEPENDENCIES_OUTCOME'],
  ['media-tools', 'COMPAT_TOOLS_OUTCOME'], ['browser-install', 'COMPAT_BROWSER_OUTCOME'],
  ['fixtures', 'COMPAT_FIXTURES_OUTCOME'], ['tests', 'COMPAT_TEST_OUTCOME'], ['slim-work', 'COMPAT_SLIM_WORK_OUTCOME'],
];
let failedStage = stages.find(([, variable]) => ['failure', 'cancelled'].includes(process.env[variable]))?.[0];
let slimStatus = null;
if (process.env.COMPAT_RUNNER_LABEL === 'ubuntu-slim') {
  try {
    const value = JSON.parse(readFileSync(path.resolve('reports/internal/slim-stage.json'), 'utf8'));
    slimStatus = {
      stage: safeLabel(value.stage), status: safeLabel(value.status),
      code: PUBLIC_ERROR_CODES.has(value.code) ? value.code : null,
      elapsedMs: Number.isFinite(value.elapsedMs) ? value.elapsedMs : null,
      exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
      dependencyCode: /^E[A-Z0-9_]+$/.test(value.dependencyCode || '') ? value.dependencyCode : null,
    };
    if (slimStatus.status !== 'passed') failedStage = slimStatus.stage;
  } catch { /* A hard step timeout still produces a fallback cell report. */ }
}
let report;
let readFailure = null;
if (existsSync(reportPath)) {
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (report.schemaVersion !== 2 || Object.entries(context).some(([key, value]) => report[key] !== value)) {
      readFailure = 'REPORT_IDENTITY_MISMATCH';
      report = null;
    }
  } catch { readFailure = 'REPORT_SCHEMA_INVALID'; }
}
if (report) {
  if (failedStage && report.status === 'passed') {
    report.status = 'failed';
    report.failureCode = slimStatus?.code || 'SETUP_FAILED';
    report.failureStage = failedStage;
  }
} else {
  report = {
    schemaVersion: 2, ...context,
    requiredChecks: planned?.checks || REQUIRED_CHECKS[context.suite],
    modelScope: planned?.modelScope || (context.suite === 'models' ? 'required' : 'not-requested'),
    modelScopeReason: planned?.modelScopeReason || null,
    status: 'setup-failed', buildId: null,
    expectedBuildId: safeBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID?.trim()),
    identityVerified: false, durationMs: null, tests: [], frameworkErrors: [],
    environment: {
      runner: safeLabel(process.env.COMPAT_RUNNER_LABEL || 'local'),
      ...runtimeForReport(await collectRuntimeEnvironment()),
    },
    failureCode: readFailure || slimStatus?.code || 'SETUP_FAILED',
    failureStage: failedStage || 'before-test-report',
    completedAt: new Date().toISOString(),
  };
}
if (slimStatus) report.setup = slimStatus;
writeCellReport(report);
console.log('Saved sanitized cell status: ' + report.cellId + ' = ' + report.status);
