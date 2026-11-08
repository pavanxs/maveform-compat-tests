import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, devices } from '@playwright/test';
import { withDeadline, boundedCleanup } from './diagnostics.mjs';
import { newDownloadState } from './downloads.mjs';
import { downloadForReport, runtimeForReport } from './report-utils.mjs';
import { collectRuntimeEnvironment } from './runtime-environment.mjs';

export const PROBE_TEXT = 'Maveform synthetic download control.\n';
const MODES = new Set(['normal', 'no-wait-after']);
const STAGES = new Set(['starting', 'server', 'launch', 'environment', 'context', 'page', 'navigation',
  'download-event-and-click', 'download-save', 'download-status', 'download-content',
  'liveness-page', 'liveness-context', 'liveness-fresh-page', 'liveness-heartbeat', 'cleanup', 'complete']);
const CODES = new Set(['PROBE_MODE_INVALID', 'PROBE_RUNNER_MISMATCH', 'PROBE_IDENTITY_INVALID',
  'PROBE_SERVER_FAILED', 'PROBE_LAUNCH_FAILED', 'PROBE_LAUNCH_TIMEOUT', 'PROBE_ENVIRONMENT_FAILED', 'PROBE_ENVIRONMENT_TIMEOUT',
  'PROBE_CONTEXT_FAILED', 'PROBE_CONTEXT_TIMEOUT', 'PROBE_PAGE_FAILED', 'PROBE_PAGE_TIMEOUT',
  'PROBE_NAVIGATION_FAILED', 'PROBE_NAVIGATION_TIMEOUT', 'PROBE_ISOLATION_MISMATCH',
  'PROBE_LIVENESS_FAILED', 'PROBE_LIVENESS_TIMEOUT', 'PROBE_CLEANUP_TIMEOUT', 'PROBE_PROCESS_TIMEOUT',
  'PROBE_UNEXPECTED_FAILURE', 'PROBE_INCOMPLETE', 'PROBE_REPORT_WRITE_FAILED',
  'DOWNLOAD_EVENT_TIMEOUT', 'DOWNLOAD_CLICK_TIMEOUT', 'DOWNLOAD_CLICK_FAILED', 'DOWNLOAD_SAVE_TIMEOUT',
  'DOWNLOAD_STATUS_TIMEOUT', 'DOWNLOAD_FAILED', 'EXPORT_METADATA_MISMATCH', 'DOWNLOAD_CONTROL_CONTENT_MISMATCH']);
const LIMITS = Object.freeze({ eventMs: 20_000, clickMs: 10_000, saveMs: 20_000, statusMs: 3000,
  livenessMs: 15_000, cancelMs: 1000 });
const expectedBytes = Buffer.byteLength(PROBE_TEXT);
const codeOf = error => CODES.has(error?.code) ? error.code : 'PROBE_UNEXPECTED_FAILURE';
function failure(code) { const error = new Error(code); error.code = code; return error; }
async function timed(operation, ms, code, fallback = code) {
  try { return await withDeadline(operation, ms, code); }
  catch (error) { throw failure(error?.code === code || error?.name === 'TimeoutError' ? code : fallback); }
}
const modeOf = value => MODES.has(value) ? value : 'unknown';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;
const codeForReport = value => CODES.has(value) ? value : null;
const heartbeatForReport = value => ({
  attempted: value?.attempted === true,
  outcome: ['responsive', 'timedout', 'failed', 'closed'].includes(value?.outcome) ? value.outcome : 'not-attempted',
  stage: ['context', 'page', 'heartbeat', 'complete'].includes(value?.stage) ? value.stage : null,
  cleanupCompleted: flag(value?.cleanupCompleted),
});

export function newProbeState(mode, env = process.env) {
  return {
    mode, status: 'running', stage: 'starting', failure: null, terminationCode: null, elapsedMs: 0,
    harnessCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    environment: null, secureContext: null, crossOriginIsolated: null,
    download: newDownloadState(null, expectedBytes), clickCompleted: false, contentMatches: null,
    liveness: { samePage: null, download: null, freshContext: null, failureCode: null },
    observed: { pageCrashed: false, pageClosed: false, browserDisconnected: false, browserConnectedBeforeCancel: null },
    cleanup: { context: null, browser: null, server: null }, reportWriteFailed: false,
  };
}

export function downloadValidated(state) {
  const item = state.download;
  return state.clickCompleted === true && item?.eventReceived === true && item.saveCompleted === true &&
    item.statusChecked === true && item.browserStatus === 'completed' && item.failureCode === null &&
    item.expectedBytes === expectedBytes && item.savedBytes === expectedBytes && state.contentMatches === true;
}
function runtimeVerified(value) {
  return value?.os?.platform === 'darwin' && /^26(?:\.|$)/.test(value.os.version || '') &&
    value.image?.os === 'macos26' && Boolean(value.image?.version) &&
    ['host', 'node', 'browser'].every(key => value.arch?.[key] === 'x64') &&
    ['mach-o-x64', 'chromium-version-x64'].includes(value.arch?.browserEvidence) &&
    value.browser?.name === 'chromium' && value.browser.channel === 'chrome' &&
    /^\d+(?:\.\d+){1,3}$/.test(value.browser.version || '') && /^24\./.test(value.node?.version || '');
}
export function publicProbeReport(state) {
  const commit = typeof state.harnessCommit === 'string' && /^[a-f0-9]{40}$/.test(state.harnessCommit) ? state.harnessCommit : null;
  const digits = value => typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
  const runId = digits(state.runId), runAttempt = digits(state.runAttempt);
  const requestedStatus = ['running', 'passed', 'failed', 'timedout'].includes(state.status) ? state.status : 'failed';
  const environment = runtimeForReport(state.environment);
  const canPass = MODES.has(state.mode) && commit && runId && runAttempt && runtimeVerified(environment) &&
    state.secureContext === true && state.crossOriginIsolated === true && downloadValidated(state) &&
    state.failure === null && state.terminationCode === null && !state.reportWriteFailed &&
    ['context', 'browser', 'server'].every(key => state.cleanup?.[key] === true);
  const incomplete = requestedStatus === 'passed' && !canPass;
  return {
    schemaVersion: 1, kind: 'intel-synthetic-download-probe', appCompatibility: 'not-tested',
    comparison: 'requires-paired-review',
    fixture: { kind: 'authored-text-blob', bytes: expectedBytes, sha256: createHash('sha256').update(PROBE_TEXT).digest('hex') },
    mode: modeOf(state.mode), status: incomplete ? 'failed' : requestedStatus,
    stage: STAGES.has(state.stage) ? state.stage : 'unknown',
    failure: state.failure ? {
      code: codeForReport(state.failure.code) || 'PROBE_UNEXPECTED_FAILURE',
      stage: STAGES.has(state.failure.stage) ? state.failure.stage : 'unknown',
    } : incomplete ? { code: 'PROBE_INCOMPLETE', stage: 'complete' } : null,
    terminationCode: codeForReport(state.terminationCode), elapsedMs: integer(state.elapsedMs),
    harnessCommit: commit, runId, runAttempt, runner: 'macos-26-intel', environment,
    settings: { channel: 'chrome', headless: true, acceptDownloads: true, noWaitAfter: state.mode === 'no-wait-after' },
    secureContext: flag(state.secureContext), crossOriginIsolated: flag(state.crossOriginIsolated),
    download: downloadForReport(state.download), clickCompleted: state.clickCompleted === true,
    contentMatches: flag(state.contentMatches), downloadValidated: downloadValidated(state),
    liveness: {
      samePage: heartbeatForReport(state.liveness?.samePage),
      download: {
        attempted: state.liveness?.download?.attempted === true,
        outcome: ['completed', 'failed', 'cancelled', 'timedout'].includes(state.liveness?.download?.outcome)
          ? state.liveness.download.outcome : 'not-attempted',
      },
      freshContext: heartbeatForReport(state.liveness?.freshContext),
      failureCode: codeForReport(state.liveness?.failureCode),
    },
    observed: {
      pageCrashed: state.observed?.pageCrashed === true, pageClosed: state.observed?.pageClosed === true,
      browserDisconnected: state.observed?.browserDisconnected === true,
      browserConnectedBeforeCancel: flag(state.observed?.browserConnectedBeforeCancel),
    },
    cleanup: Object.fromEntries(['context', 'browser', 'server'].map(key => [key, flag(state.cleanup?.[key])])),
    reportWriteFailed: state.reportWriteFailed === true,
  };
}

async function resource(operation, ms, code, dispose) {
  const pending = Promise.resolve().then(operation);
  let accepted = false;
  try { const value = await timed(pending, ms, code, code.replace(/_TIMEOUT$/, '_FAILED')); accepted = true; return value; }
  finally {
    if (!accepted) void pending.then(late => boundedCleanup(() => dispose(late))).catch(() => {});
  }
}

export async function probeLiveness({ browser, page, download = null, state, update = () => {}, timeoutMs = 2000 }) {
  state.observed.browserConnectedBeforeCancel = browser.isConnected();
  state.stage = 'liveness-page';
  const same = state.liveness.samePage = { attempted: true, outcome: 'failed' };
  update();
  try {
    if (page.isClosed()) same.outcome = 'closed';
    else same.outcome = await timed(() => page.evaluate(() => true), timeoutMs, 'PROBE_LIVENESS_TIMEOUT', 'PROBE_LIVENESS_FAILED')
      ? 'responsive' : 'failed';
  } catch (error) { same.outcome = error.code === 'PROBE_LIVENESS_TIMEOUT' ? 'timedout' : 'failed'; }
  update();
  if (download) {
    const saved = state.liveness.download = { attempted: true, outcome: 'failed' };
    update();
    try {
      const issue = await timed(() => download.failure(), timeoutMs, 'PROBE_LIVENESS_TIMEOUT', 'PROBE_LIVENESS_FAILED');
      saved.outcome = issue === null ? 'completed' : issue === 'canceled' || issue === 'cancelled' ? 'cancelled' : 'failed';
    } catch (error) { saved.outcome = error.code === 'PROBE_LIVENESS_TIMEOUT' ? 'timedout' : 'failed'; }
    update();
  }
  const fresh = state.liveness.freshContext = { attempted: true, outcome: 'failed', stage: 'context', cleanupCompleted: null };
  let context;
  try {
    state.stage = 'liveness-context'; update();
    context = await resource(() => browser.newContext(), timeoutMs, 'PROBE_LIVENESS_TIMEOUT', value => value.close());
    fresh.stage = 'page'; state.stage = 'liveness-fresh-page'; update();
    const newPage = await resource(() => context.newPage(), timeoutMs, 'PROBE_LIVENESS_TIMEOUT', value => value.close());
    fresh.stage = 'heartbeat'; state.stage = 'liveness-heartbeat'; update();
    fresh.outcome = await timed(() => newPage.evaluate(() => true), timeoutMs, 'PROBE_LIVENESS_TIMEOUT', 'PROBE_LIVENESS_FAILED')
      ? 'responsive' : 'failed';
    fresh.stage = 'complete';
  } catch (error) { fresh.outcome = error.code === 'PROBE_LIVENESS_TIMEOUT' ? 'timedout' : 'failed'; }
  finally { if (context) fresh.cleanupCompleted = await boundedCleanup(() => context.close(), timeoutMs); update(); }
}

export async function exerciseDownload({
  page, mode, filename, state, update = () => {}, beforeCancel = async () => {},
  readSaved = () => readFileSync(filename), limits = {},
}) {
  if (!MODES.has(mode)) throw failure('PROBE_MODE_INVALID');
  const budget = { ...LIMITS, ...limits };
  let download, settle;
  const pendingEvent = new Promise(resolve => { settle = resolve; });
  const received = value => { download = value; state.download.eventReceived = true; update(); settle(value); };
  page.once('download', received);
  try {
    state.stage = 'download-event-and-click'; update();
    const click = timed(() => page.getByTestId('probe-download').click({
      timeout: budget.clickMs, noWaitAfter: mode === 'no-wait-after',
    }), budget.clickMs, 'DOWNLOAD_CLICK_TIMEOUT', 'DOWNLOAD_CLICK_FAILED').then(() => { state.clickCompleted = true; update(); });
    await Promise.all([timed(pendingEvent, budget.eventMs, 'DOWNLOAD_EVENT_TIMEOUT'), click]);
    state.stage = 'download-save'; state.download.phase = 'save'; update();
    await timed(() => download.saveAs(filename), budget.saveMs, 'DOWNLOAD_SAVE_TIMEOUT', 'DOWNLOAD_FAILED');
    state.download.saveCompleted = true; update();
    state.stage = 'download-status'; state.download.phase = 'status'; update();
    const issue = await timed(() => download.failure(), budget.statusMs, 'DOWNLOAD_STATUS_TIMEOUT', 'DOWNLOAD_FAILED');
    state.download.statusChecked = true;
    state.download.browserStatus = issue === null ? 'completed' : issue === 'canceled' || issue === 'cancelled' ? 'cancelled' : 'failed';
    update();
    if (issue !== null) throw failure('DOWNLOAD_FAILED');
    state.stage = 'download-content'; update();
    const bytes = readSaved();
    state.download.savedBytes = bytes.length;
    if (bytes.length !== expectedBytes) throw failure('EXPORT_METADATA_MISMATCH');
    state.contentMatches = Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(PROBE_TEXT));
    if (!state.contentMatches) throw failure('DOWNLOAD_CONTROL_CONTENT_MISMATCH');
    state.download.phase = 'complete'; update();
  } catch (error) {
    const primary = codeOf(error);
    state.failure = { code: primary, stage: state.stage };
    state.download.failureCode = primary; update();
    // Check responsiveness before cancel(), which itself stalled in the real run.
    try { await timed(() => beforeCancel({ download }), budget.livenessMs, 'PROBE_LIVENESS_TIMEOUT', 'PROBE_LIVENESS_FAILED'); }
    catch (probeError) { state.liveness.failureCode = codeOf(probeError); }
    if (download) {
      state.download.cancelAttempted = true; update();
      state.download.cancelCompleted = await boundedCleanup(() => download.cancel(), budget.cancelMs);
    }
    update();
    throw failure(primary);
  } finally { page.off('download', received); settle(null); }
}

async function run(mode) {
  const state = newProbeState(mode);
  const started = Date.now();
  const output = path.resolve('reports/intel-download-probe', modeOf(mode) + '.json');
  const artifact = path.resolve('.local-test-results/intel-download-probe', modeOf(mode) + '.txt');
  let browser, context, server, cleaning = false;
  const update = () => {
    state.elapsedMs = Date.now() - started;
    try {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output + '.tmp', JSON.stringify(publicProbeReport(state), null, 2) + '\n');
      renameSync(output + '.tmp', output);
      return true;
    } catch { state.reportWriteFailed = true; return false; }
  };
  const stop = code => {
    state.status = code === 'PROBE_PROCESS_TIMEOUT' ? 'timedout' : 'failed';
    state.failure ||= { code, stage: state.stage };
    state.terminationCode = code;
    update();
    process.exit(1);
  };
  const watchdog = setTimeout(() => stop('PROBE_PROCESS_TIMEOUT'), 120_000);
  process.once('uncaughtException', () => stop('PROBE_UNEXPECTED_FAILURE'));
  process.once('unhandledRejection', () => stop('PROBE_UNEXPECTED_FAILURE'));
  update();
  try {
    if (!MODES.has(mode)) throw failure('PROBE_MODE_INVALID');
    if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin' || process.arch !== 'x64') throw failure('PROBE_RUNNER_MISMATCH');
    const identity = publicProbeReport(state);
    if (!identity.harnessCommit || !identity.runId || !identity.runAttempt) throw failure('PROBE_IDENTITY_INVALID');
    mkdirSync(path.dirname(artifact), { recursive: true });
    state.stage = 'server'; update();
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic download probe</title></head><body>' +
      '<a data-testid="probe-download" download="synthetic-control.txt">Download synthetic text</a><script>' +
      'document.querySelector("a").href = URL.createObjectURL(new Blob([' + JSON.stringify(PROBE_TEXT) + '], {type:"text/plain"}));' +
      '</script></body></html>';
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
      response.end(html);
    });
    await timed(() => new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    }), 3000, 'PROBE_SERVER_FAILED');
    state.stage = 'launch'; update();
    browser = await resource(() => chromium.launch({ channel: 'chrome', headless: true, timeout: 45_000 }),
      46_000, 'PROBE_LAUNCH_TIMEOUT', value => value.close());
    browser.on('disconnected', () => { if (!cleaning) { state.observed.browserDisconnected = true; update(); } });
    state.stage = 'environment'; update();
    state.environment = await timed(() => collectRuntimeEnvironment({ browser, channel: 'chrome' }),
      35_000, 'PROBE_ENVIRONMENT_TIMEOUT', 'PROBE_ENVIRONMENT_FAILED');
    if (!runtimeVerified(state.environment)) throw failure('PROBE_RUNNER_MISMATCH');
    state.stage = 'context'; update();
    context = await resource(() => browser.newContext({ ...devices['Desktop Chrome'], acceptDownloads: true }),
      5000, 'PROBE_CONTEXT_TIMEOUT', value => value.close());
    state.stage = 'page'; update();
    const page = await resource(() => context.newPage(), 5000, 'PROBE_PAGE_TIMEOUT', value => value.close());
    page.on('crash', () => { if (!cleaning) { state.observed.pageCrashed = true; update(); } });
    page.on('close', () => { if (!cleaning) { state.observed.pageClosed = true; update(); } });
    state.stage = 'navigation'; update();
    await timed(() => page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded', timeout: 5000 }),
      6000, 'PROBE_NAVIGATION_TIMEOUT', 'PROBE_NAVIGATION_FAILED');
    const origin = await timed(() => page.evaluate(() => ({ secure: isSecureContext, isolated: crossOriginIsolated })),
      2000, 'PROBE_PAGE_TIMEOUT', 'PROBE_PAGE_FAILED');
    state.secureContext = origin.secure; state.crossOriginIsolated = origin.isolated; update();
    if (!origin.secure || !origin.isolated) throw failure('PROBE_ISOLATION_MISMATCH');
    await exerciseDownload({ page, mode, filename: artifact, state, update,
      beforeCancel: ({ download }) => probeLiveness({ browser, page, download, state, update }) });
  } catch (error) {
    state.failure ||= { code: codeOf(error), stage: state.stage };
    state.status = 'failed'; update();
  } finally {
    cleaning = true; state.stage = 'cleanup'; update();
    if (context) state.cleanup.context = await boundedCleanup(() => context.close(), 2000);
    if (browser) state.cleanup.browser = await boundedCleanup(() => browser.close(), 2000);
    if (server) {
      server.closeAllConnections();
      state.cleanup.server = await boundedCleanup(() => new Promise(resolve => server.close(resolve)), 1000);
    }
    if (!state.failure && !Object.values(state.cleanup).every(value => value === true)) state.failure = { code: 'PROBE_CLEANUP_TIMEOUT', stage: 'cleanup' };
    if (state.reportWriteFailed) state.failure ||= { code: 'PROBE_REPORT_WRITE_FAILED', stage: 'cleanup' };
    state.stage = 'complete'; state.status = state.failure ? 'failed' : 'passed';
    const written = update();
    clearTimeout(watchdog);
    const report = publicProbeReport(state);
    console.log('INTEL_DOWNLOAD_PROBE ' + modeOf(mode) + ' ' + report.status.toUpperCase() +
      (report.failure ? ' ' + report.failure.code : ''));
    // Do not let an unresponsive browser transport keep the reporting process alive.
    process.exit(written && report.status === 'passed' ? 0 : 1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await run(process.argv[2]);
}
