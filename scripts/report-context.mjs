import { execFileSync } from 'node:child_process';
import { safeBuildId, safeLabel } from './report-utils.mjs';

export function safeCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
}
function actualCommit() {
  try {
    return safeCommit(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim());
  } catch { return null; }
}
export function collectReportContext(env = process.env) {
  const suite = ['smoke', 'models'].includes(env.COMPAT_SUITE) ? env.COMPAT_SUITE : 'smoke';
  return {
    cellId: safeLabel(env.COMPAT_CELL_ID || 'local-' + process.platform + '-' + process.arch + '-' + (env.COMPAT_BROWSER || 'chrome')),
    profileId: safeLabel(env.COMPAT_PROFILE || 'local'),
    requestedSuite: ['smoke', 'models'].includes(env.COMPAT_REQUESTED_SUITE) ? env.COMPAT_REQUESTED_SUITE : suite,
    suite,
    harnessCommit: actualCommit(), expectedHarnessCommit: safeCommit(env.COMPAT_HARNESS_COMMIT),
    runId: safeLabel(env.GITHUB_RUN_ID || 'local'), runAttempt: safeLabel(env.GITHUB_RUN_ATTEMPT || '1'),
  };
}
export function requestedRun(env = process.env) {
  return {
    profileId: env.COMPAT_PROFILE || 'current',
    suite: env.COMPAT_REQUESTED_SUITE || env.COMPAT_SUITE || 'smoke',
    expectedBuildId: safeBuildId(env.MAVEFORM_EXPECTED_BUILD_ID?.trim()),
    harnessCommit: safeCommit(env.COMPAT_HARNESS_COMMIT || env.GITHUB_SHA),
    runId: env.GITHUB_RUN_ID || null, runAttempt: env.GITHUB_RUN_ATTEMPT || null,
  };
}
