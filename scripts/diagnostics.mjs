import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runtimeForReport, downloadForReport, safeBuildId, safeLabel } from './report-utils.mjs';

export const DIAGNOSTIC_STAGES = new Set([
  'test-starting', 'browser-launch', 'browser-ready', 'browser-teardown', 'page-setup',
  'runtime-environment', 'runtime-cdp-session', 'runtime-cdp-command', 'runtime-binary-inspection',
  'runtime-version-context', 'runtime-version-page', 'runtime-version-navigation', 'runtime-version-read',
  'runtime-environment-ready', 'opening', 'navigation', 'identity', 'capabilities', 'source-upload',
  'browser-source-decode', 'export-captions-on', 'export-captions-off', 'download',
  'download-event-captions-off', 'download-event-captions-on', 'download-save-captions-off', 'download-save-captions-on',
  'download-status-captions-off', 'download-status-captions-on', 'download-complete-captions-off', 'download-complete-captions-on',
  'validate-media', 'validate-captions', 'compare-captions', 'caption-comparison', 'caption-pixel-comparison',
  'external-validation-captions-off', 'external-validation-captions-on', 'real-core-models', 'complete',
]);
const CHECKS = new Set(['worker', 'media-smoke', 'core-models']);
const CONTEXT_KEYS = ['cellId', 'profileId', 'requestedSuite', 'suite', 'harnessCommit', 'expectedHarnessCommit', 'runId', 'runAttempt'];

export function withDeadline(operation, timeoutMs, code) {
  let timer;
  const work = Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { const error = new Error(code); error.code = code; reject(error); }, timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function boundedCleanup(dispose, timeoutMs = 1000) {
  try { await withDeadline(dispose, timeoutMs, 'DIAGNOSTIC_CLEANUP_TIMEOUT'); return true; }
  catch { return false; }
}

export function checkIdForFile(file = '') {
  return file.endsWith('media.smoke.spec.mjs') ? 'media-smoke' : file.endsWith('core-models.spec.mjs') ? 'core-models' : 'unknown';
}

export function progressForReport(checkId, diagnostics, context) {
  return {
    schemaVersion: 1, checkId,
    reportContext: Object.fromEntries(CONTEXT_KEYS.map(key => [key,
      ['harnessCommit', 'expectedHarnessCommit'].includes(key) ? safeBuildId(context?.[key]) : safeLabel(context?.[key])])),
    stage: DIAGNOSTIC_STAGES.has(diagnostics?.stage) ? diagnostics.stage : 'unknown',
    buildId: safeBuildId(diagnostics?.buildId), identityVerified: diagnostics?.identityVerified === true,
    runtimeEnvironment: diagnostics?.runtimeEnvironment ? runtimeForReport(diagnostics.runtimeEnvironment) : null,
    models: { attempted: diagnostics?.models?.attempted === true, completed: diagnostics?.models?.completed === true },
    download: downloadForReport(diagnostics?.download),
    updatedAt: typeof diagnostics?.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(diagnostics.updatedAt) ? diagnostics.updatedAt : new Date().toISOString(),
  };
}

function checkpointPath(checkId, context) {
  if (!CHECKS.has(checkId)) throw new Error('DIAGNOSTIC_CHECKPOINT_INVALID');
  return path.resolve('reports/internal/progress', safeLabel(context.cellId) + '-' + checkId + '.json');
}

export function writeCheckpoint(checkId, diagnostics, context) {
  const file = checkpointPath(checkId, context);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(progressForReport(checkId, diagnostics, context)) + '\n');
    renameSync(file + '.tmp', file);
    return true;
  } catch { return false; }
}

export function readCheckpoint(checkId, context) {
  try {
    const value = JSON.parse(readFileSync(checkpointPath(checkId, context), 'utf8'));
    if (value.schemaVersion !== 1 || value.checkId !== checkId ||
        CONTEXT_KEYS.some(key => value.reportContext?.[key] !== context[key])) return null;
    return progressForReport(checkId, value, context);
  } catch { return null; }
}

export function clearCheckpoints(context) {
  for (const checkId of CHECKS) {
    const file = checkpointPath(checkId, context);
    try { if (existsSync(file)) unlinkSync(file); } catch {}
  }
}

export function unfinishedTest(check, progress, status = 'interrupted') {
  return {
    checkId: check.checkId, title: check.title, status: status === 'timedout' ? 'timedOut' : 'interrupted',
    durationMs: null, failure: { code: status === 'timedout' ? 'TEST_TIMEOUT' : 'TEST_INTERRUPTED', stage: progress?.stage || 'test-starting' },
    diagnostics: progress ? { ...progress, failure: { code: status === 'timedout' ? 'TEST_TIMEOUT' : 'TEST_INTERRUPTED', stage: progress.stage } } : null,
    diagnosticSource: 'checkpoint',
  };
}
