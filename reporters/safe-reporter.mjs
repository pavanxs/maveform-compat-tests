import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { writeCellReport } from '../scripts/cell-report.mjs';
import { publicFailure, safeBuildId, safeLabel, runtimeForReport } from '../scripts/report-utils.mjs';
import { createPlan, REQUIRED_CHECKS } from '../scripts/profiles.mjs';
import { collectReportContext } from '../scripts/report-context.mjs';
import { collectRuntimeEnvironment } from '../scripts/runtime-environment.mjs';

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
        diagnostics.runtimeEnvironment = runtimeForReport(diagnostics.runtimeEnvironment);
      } catch { diagnostics = null; }
    }
    const status = result.status === 'passed' && test.expectedStatus === 'passed' ? 'passed' : result.status === 'passed' ? 'unexpected' : result.status;
    const failure = status === 'passed' ? null : (diagnostics?.failure || publicFailure(result.error, diagnostics?.stage || 'test-runner'));
    const checkId = test.location.file.endsWith('media.smoke.spec.mjs') ? 'media-smoke' :
      test.location.file.endsWith('core-models.spec.mjs') ? 'core-models' : 'unknown';
    this.tests.push({ checkId, title: test.title, status, durationMs: result.duration, failure, diagnostics });
    console.log(status.toUpperCase() + ': ' + test.title + (failure ? ' [' + failure.code + ' at ' + failure.stage + ']' : ''));
  }
  async onEnd(result) {
    const context = collectReportContext();
    let planned = null;
    try { planned = createPlan(context.profileId, context.requestedSuite).cells.find(cell => cell.id === context.cellId); }
    catch { /* Local runs have no hosted profile. CI is checked below and by the aggregate. */ }
    const requiredChecks = planned?.checks || REQUIRED_CHECKS[context.suite];
    const checkIds = this.tests.map(test => test.checkId);
    const checksComplete = checkIds.length === requiredChecks.length && new Set(checkIds).size === checkIds.length &&
      requiredChecks.every(check => checkIds.includes(check));
    const ids = new Set(this.tests.map(test => test.diagnostics?.buildId).filter(Boolean));
    const buildId = ids.size === 1 ? [...ids][0] : null;
    const expected = safeBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID?.trim());
    const identityVerified = Boolean(expected && buildId === expected && this.tests.length > 0 &&
      this.tests.every(test => test.diagnostics?.buildId === expected && test.diagnostics?.identityVerified === true));
    const contextFailure = process.env.CI && !planned ? 'PROFILE_INVALID' :
      process.env.CI && (!context.expectedHarnessCommit || context.harnessCommit !== context.expectedHarnessCommit) ? 'HARNESS_ID_MISMATCH' : null;
    const failureCode = contextFailure || (ids.size > 1 ? 'BUILD_ID_CHANGED_DURING_RUN' : null) ||
      (process.env.CI && result.status === 'passed' && !identityVerified ? 'BUILD_ID_MISMATCH' : null) ||
      this.globalErrors[0]?.code || (!checksComplete ? 'EXPECTED_TESTS_NOT_PASSED' : null);
    const allPassed = result.status === 'passed' && checksComplete &&
      this.tests.every(test => test.status === 'passed') && !failureCode &&
      (!process.env.CI || identityVerified);
    const observed = this.tests.map(test => test.diagnostics?.runtimeEnvironment).find(value => value?.browser?.version) ||
      runtimeForReport(await collectRuntimeEnvironment());
    writeCellReport({
      schemaVersion: 2, ...context,
      requiredChecks: [...requiredChecks],
      modelScope: planned?.modelScope || (context.suite === 'models' ? 'required' : 'not-requested'),
      modelScopeReason: planned?.modelScopeReason || null,
      status: allPassed ? 'passed' : result.status === 'passed' ? 'incomplete' : result.status,
      buildId, expectedBuildId: expected, identityVerified,
      durationMs: result.duration,
      environment: {
        runner: safeLabel(process.env.COMPAT_RUNNER_LABEL || 'local'),
        ...observed, playwright: require('@playwright/test/package.json').version,
      },
      tests: this.tests, frameworkErrors: this.globalErrors,
      failureCode, failureStage: this.globalErrors[0]?.stage || (contextFailure ? 'report-identity' : null),
      completedAt: new Date().toISOString(),
    });
  }
}
