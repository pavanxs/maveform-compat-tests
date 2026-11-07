import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { writeCellReport } from '../scripts/cell-report.mjs';
import { publicFailure, safeBuildId, safeLabel, runtimeForReport, downloadForReport } from '../scripts/report-utils.mjs';
import { createPlan, REQUIRED_CHECKS } from '../scripts/profiles.mjs';
import { collectReportContext } from '../scripts/report-context.mjs';
import { collectRuntimeEnvironment } from '../scripts/runtime-environment.mjs';
import { checkIdForFile, clearCheckpoints, readCheckpoint, unfinishedTest } from '../scripts/diagnostics.mjs';

const require = createRequire(import.meta.url);

export default class SafeReporter {
  tests = [];
  globalErrors = [];
  discovered = [];
  started = new Set();
  context = null;
  onBegin(config, suite) {
    this.context = collectReportContext();
    clearCheckpoints(this.context);
    this.discovered = suite.allTests().map(test => ({ id: test.id, checkId: checkIdForFile(test.location.file), title: test.title }));
    console.log('Running ' + (process.env.COMPAT_SUITE || 'smoke') + ' compatibility checks; only sanitized diagnostics will be reported.');
  }
  onTestBegin(test) { this.started.add(test.id); }
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
        diagnostics.download = downloadForReport(diagnostics.download);
      } catch { diagnostics = null; }
    }
    let status = result.status === 'passed' && test.expectedStatus === 'passed' ? 'passed' : result.status === 'passed' ? 'unexpected' : result.status;
    const checkId = checkIdForFile(test.location.file);
    let diagnosticSource = 'attachment';
    if (!diagnostics) {
      diagnostics = readCheckpoint(checkId, this.context) || readCheckpoint('worker', this.context);
      diagnosticSource = 'checkpoint';
      // A progress checkpoint alone can never certify a passing test.
      if (status === 'passed') status = 'incomplete';
    }
    const failure = status === 'passed' ? null : status === 'incomplete'
      ? { code: 'DIAGNOSTICS_INCOMPLETE', stage: diagnostics?.stage || 'test-runner' }
      : (diagnostics?.failure || publicFailure(result.error, diagnostics?.stage || 'test-runner'));
    this.tests.push({ checkId, title: test.title, status, durationMs: result.duration, failure, diagnostics, diagnosticSource });
    console.log(status.toUpperCase() + ': ' + test.title + (failure ? ' [' + failure.code + ' at ' + failure.stage + ']' : ''));
  }
  async onEnd(result) {
    const context = this.context || collectReportContext();
    const completedCount = this.tests.length;
    const workerProgress = readCheckpoint('worker', context);
    for (const check of this.discovered) {
      if (this.tests.some(test => test.checkId === check.checkId)) continue;
      const progress = readCheckpoint(check.checkId, context) || workerProgress;
      const unfinished = unfinishedTest(check, progress, result.status);
      if (this.globalErrors[0]?.code) {
        unfinished.failure.code = this.globalErrors[0].code;
        if (unfinished.diagnostics) unfinished.diagnostics.failure = { ...unfinished.failure };
      }
      this.tests.push(unfinished);
    }
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
      lifecycle: { discoveredTests: this.discovered.length, startedTests: this.started.size, completedTests: completedCount, workerStage: workerProgress?.stage || null },
      failureCode, failureStage: this.globalErrors[0]?.stage || (contextFailure ? 'report-identity' : null),
      completedAt: new Date().toISOString(),
    });
  }
}
