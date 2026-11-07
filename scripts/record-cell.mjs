import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCellReport } from './cell-report.mjs';
import { safeBuildId, safeLabel } from './report-utils.mjs';

const cellId = safeLabel(process.env.COMPAT_CELL_ID || 'local-' + process.platform + '-' + process.arch);
const reportPath = path.resolve('reports/public', cellId + '.json');
const stages = [
  ['target', 'COMPAT_TARGET_OUTCOME'],
  ['dependencies', 'COMPAT_DEPENDENCIES_OUTCOME'],
  ['media-tools', 'COMPAT_TOOLS_OUTCOME'],
  ['browser-install', 'COMPAT_BROWSER_OUTCOME'],
  ['fixtures', 'COMPAT_FIXTURES_OUTCOME'],
  ['tests', 'COMPAT_TEST_OUTCOME'],
];
const failedStage = stages.find(([, variable]) => ['failure', 'cancelled'].includes(process.env[variable]));
let report;
if (existsSync(reportPath)) {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (failedStage && report.status === 'passed') {
    report.status = 'failed';
    report.failureCode = 'SETUP_FAILED';
    report.failureStage = failedStage[0];
  }
} else {
  report = {
    schemaVersion: 1, cellId,
    runId: process.env.GITHUB_RUN_ID || 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    suite: process.env.COMPAT_SUITE || 'smoke',
    status: 'setup-failed', buildId: null,
    expectedBuildId: safeBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID?.trim()),
    identityVerified: false, durationMs: null, tests: [],
    environment: {
      runner: process.env.COMPAT_RUNNER_LABEL || 'local', os: process.platform,
      osRelease: os.release(), arch: process.arch, node: process.version,
      browser: process.env.COMPAT_BROWSER || 'unknown', imageVersion: process.env.ImageVersion || null,
    },
    failureCode: 'SETUP_FAILED', failureStage: failedStage?.[0] || 'before-test-report',
    completedAt: new Date().toISOString(),
  };
}
writeCellReport(report);
console.log('Saved sanitized cell status: ' + report.cellId + ' = ' + report.status);
