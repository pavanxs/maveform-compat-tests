import { readFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { writeCellReport } from '../scripts/cell-report.mjs';
import { publicFailure, safeBuildId, safeLabel } from '../scripts/report-utils.mjs';

const require = createRequire(import.meta.url);

export default class SafeReporter {
  tests = [];
  globalErrors = [];
  onBegin() {
    console.log('Running ' + (process.env.COMPAT_SUITE || 'smoke') + ' compatibility checks; only sanitized diagnostics will be reported.');
  }
  onStdOut() {}
  onStdErr() {}
  onError(error) {
    this.globalErrors.push(publicFailure(error, 'test-runner'));
  }
  onTestEnd(test, result) {
    let diagnostics = null;
    const attachment = result.attachments.find(item => item.name === 'safe-diagnostics');
    if (attachment) {
      try {
        diagnostics = JSON.parse(attachment.body ? attachment.body.toString('utf8') : readFileSync(attachment.path, 'utf8'));
      } catch { /* Missing diagnostics cannot turn a failed test into a pass. */ }
    }
    const status = result.status === 'passed' && test.expectedStatus === 'passed' ? 'passed' : result.status === 'passed' ? 'unexpected' : result.status;
    const failure = status === 'passed' ? null : (diagnostics?.failure || publicFailure(result.error, diagnostics?.stage || 'test-runner'));
    const checkId = test.location.file.endsWith('media.smoke.spec.mjs') ? 'media-smoke' :
      test.location.file.endsWith('core-models.spec.mjs') ? 'core-models' : 'unknown';
    this.tests.push({ checkId, title: test.title, status, durationMs: result.duration, failure, diagnostics });
    console.log(status.toUpperCase() + ': ' + test.title + (failure ? ' [' + failure.code + ' at ' + failure.stage + ']' : ''));
  }
  onEnd(result) {
    const ids = new Set(this.tests.map(test => test.diagnostics?.buildId).filter(Boolean));
    const buildId = ids.size === 1 ? [...ids][0] : null;
    const expected = safeBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID?.trim());
    const suite = process.env.COMPAT_SUITE || 'smoke';
    const expectedTests = suite === 'models' ? 2 : 1;
    const allPassed = result.status === 'passed' && this.tests.length === expectedTests &&
      this.tests.every(test => test.status === 'passed') && this.globalErrors.length === 0;
    const report = {
      schemaVersion: 1,
      cellId: safeLabel(process.env.COMPAT_CELL_ID || 'local-' + process.platform + '-' + process.arch + '-' + (process.env.COMPAT_BROWSER || 'chrome')),
      runId: process.env.GITHUB_RUN_ID || 'local',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
      suite, status: allPassed ? 'passed' : result.status === 'passed' ? 'incomplete' : result.status,
      buildId, expectedBuildId: expected, identityVerified: Boolean(expected && buildId === expected),
      durationMs: result.duration,
      environment: {
        runner: process.env.COMPAT_RUNNER_LABEL || 'local',
        os: process.platform, osRelease: os.release(), arch: process.arch,
        node: process.version, playwright: require('@playwright/test/package.json').version,
        browser: process.env.COMPAT_BROWSER || 'chrome',
        imageVersion: process.env.ImageVersion || null,
      },
      tests: this.tests, frameworkErrors: this.globalErrors,
      failureCode: ids.size > 1 ? 'BUILD_ID_CHANGED_DURING_RUN' :
        this.globalErrors[0]?.code || (this.tests.length !== expectedTests ? 'EXPECTED_TESTS_NOT_PASSED' : null),
      failureStage: this.globalErrors[0]?.stage || null,
      completedAt: new Date().toISOString(),
    };
    writeCellReport(report);
  }
}
