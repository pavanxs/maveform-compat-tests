import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PROBE_TEXT, newProbeState, downloadValidated, publicProbeReport, exerciseDownload, probeLiveness } from './intel-download-probe.mjs';

const never = () => new Promise(() => {});
const limits = { eventMs: 30, clickMs: 20, saveMs: 20, statusMs: 20, livenessMs: 20, cancelMs: 10 };
const identity = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
function sample(mode = 'normal') {
  const page = new EventEmitter();
  const calls = [];
  const download = {
    saveAs: async () => { calls.push('save'); },
    failure: async () => { calls.push('status'); return null; },
    cancel: async () => { calls.push('cancel'); },
  };
  page.getByTestId = name => ({
    click: async options => {
      assert.equal(name, 'probe-download');
      calls.push({ click: options });
      page.emit('download', download);
    },
  });
  const state = newProbeState(mode, identity);
  return { page, download, calls, state, options: {
    page, mode, filename: 'unused-synthetic-path', state, limits,
    readSaved: () => Buffer.from(PROBE_TEXT),
    beforeCancel: async () => { calls.push('liveness'); },
  } };
}

for (const mode of ['normal', 'no-wait-after', 'headed']) {
  test('synthetic ' + mode + ' requires click, real save, completion and exact content', async () => {
    const item = sample(mode);
    await exerciseDownload(item.options);
    assert.equal(Buffer.byteLength(PROBE_TEXT), 37);
    assert.deepEqual(item.calls, [{ click: { timeout: limits.clickMs, noWaitAfter: mode === 'no-wait-after' } }, 'save', 'status']);
    assert.equal(item.state.download.savedBytes, 37);
    assert.equal(item.state.contentMatches, true);
    assert.equal(downloadValidated(item.state), true);
    assert.equal(item.page.listenerCount('download'), 0);
  });
}

test('a download before a stuck click is captured; liveness precedes cancellation', { timeout: 1000 }, async () => {
  const item = sample();
  item.page.getByTestId = () => ({ click: () => { item.page.emit('download', item.download); return never(); } });
  await assert.rejects(() => exerciseDownload(item.options), { code: 'DOWNLOAD_CLICK_TIMEOUT' });
  assert.deepEqual(item.calls, ['liveness', 'cancel']);
  assert.equal(item.state.download.eventReceived, true);
  assert.equal(item.state.clickCompleted, false);
  assert.equal(item.state.download.saveCompleted, false);
  assert.equal(downloadValidated(item.state), false);
  assert.equal(item.state.failure.stage, 'download-event-and-click');
  assert.equal(item.page.listenerCount('download'), 0);
});

test('broken or stuck liveness/cancellation never hides the primary failure', { timeout: 1000 }, async () => {
  for (const beforeCancel of [never, async () => { throw new Error('synthetic private detail'); }]) {
    const item = sample();
    item.download.saveAs = never;
    item.download.cancel = never;
    await assert.rejects(() => exerciseDownload({ ...item.options, beforeCancel }), { code: 'DOWNLOAD_SAVE_TIMEOUT' });
    assert.equal(item.state.failure.code, 'DOWNLOAD_SAVE_TIMEOUT');
    assert.equal(item.state.download.cancelAttempted, true);
    assert.equal(item.state.download.cancelCompleted, false);
    assert.equal(downloadValidated(item.state), false);
    assert.doesNotMatch(JSON.stringify(publicProbeReport(item.state)), /private detail/);
  }
});

test('missing events and stalled completion retain different failure codes', { timeout: 1000 }, async () => {
  const missing = sample();
  missing.page.getByTestId = () => ({ click: async () => {} });
  await assert.rejects(() => exerciseDownload(missing.options), { code: 'DOWNLOAD_EVENT_TIMEOUT' });
  assert.equal(missing.state.download.eventReceived, false);
  assert.equal(missing.page.listenerCount('download'), 0);
  const status = sample();
  status.download.failure = never;
  await assert.rejects(() => exerciseDownload(status.options), { code: 'DOWNLOAD_STATUS_TIMEOUT' });
  assert.equal(status.state.download.saveCompleted, true);
  assert.equal(status.state.download.statusChecked, false);
});

test('a completed download with wrong bytes or same-length wrong content cannot pass', async () => {
  for (const [bytes, code] of [
    [Buffer.from('short'), 'EXPORT_METADATA_MISMATCH'],
    [Buffer.from('X' + PROBE_TEXT.slice(1)), 'DOWNLOAD_CONTROL_CONTENT_MISMATCH'],
  ]) {
    const item = sample();
    await assert.rejects(() => exerciseDownload({ ...item.options, readSaved: () => bytes }), { code });
    assert.equal(item.state.download.saveCompleted, true);
    assert.equal(item.state.download.statusChecked, true);
    assert.equal(downloadValidated(item.state), false);
  }
});

test('fresh-context heartbeat distinguishes a stalled page and records download status before cleanup', { timeout: 1000 }, async () => {
  const order = [];
  const state = newProbeState('normal', identity);
  const browser = {
    isConnected: () => true,
    newContext: async () => {
      order.push('context');
      return {
        newPage: async () => ({ evaluate: async () => { order.push('fresh-heartbeat'); return true; } }),
        close: async () => { order.push('close-fresh-context'); },
      };
    },
  };
  await probeLiveness({
    browser, page: { isClosed: () => false, evaluate: never },
    download: { failure: async () => { order.push('download-status'); return null; } },
    state, timeoutMs: 10,
  });
  assert.deepEqual(order, ['download-status', 'context', 'fresh-heartbeat', 'close-fresh-context']);
  assert.equal(state.liveness.samePage.outcome, 'timedout');
  assert.equal(state.liveness.download.outcome, 'completed');
  assert.equal(state.liveness.freshContext.outcome, 'responsive');
  assert.equal(state.liveness.freshContext.cleanupCompleted, true);
  assert.equal(state.observed.browserConnectedBeforeCancel, true);
});

test('failed context creation is distinct from a timeout and any late context is closed', { timeout: 1000 }, async () => {
  const makeState = () => newProbeState('normal', identity);
  const page = { isClosed: () => false, evaluate: async () => true };
  const broken = makeState();
  await probeLiveness({ browser: { isConnected: () => true, newContext: async () => { throw new Error('synthetic secret path'); } }, page, state: broken, timeoutMs: 10 });
  assert.equal(broken.liveness.freshContext.outcome, 'failed');
  let resolveContext, lateClosed = false;
  const delayed = makeState();
  await probeLiveness({
    browser: { isConnected: () => true, newContext: () => new Promise(resolve => { resolveContext = resolve; }) },
    page, state: delayed, timeoutMs: 10,
  });
  assert.equal(delayed.liveness.freshContext.outcome, 'timedout');
  resolveContext({ close: async () => { lateClosed = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateClosed, true);
  assert.doesNotMatch(JSON.stringify(publicProbeReport(broken)), /secret path/);
});

function passedState(mode = 'normal') {
  const state = newProbeState(mode, identity);
  state.environment = {
    os: { platform: 'darwin', version: '26.6.1', release: '25.6.0', product: 'macOS' },
    image: { os: 'macos26', version: '20260824.0517.1' },
    arch: { host: 'x64', node: 'x64', browser: 'x64', browserEvidence: 'chromium-version-x64' },
    browser: { name: 'chromium', channel: 'chrome', version: '157.0.8103.39' },
    node: { version: '24.19.0' },
  };
  Object.assign(state.download, { eventReceived: true, saveCompleted: true, statusChecked: true, browserStatus: 'completed', savedBytes: 37, phase: 'complete' });
  Object.assign(state, { status: 'passed', stage: 'complete', clickCompleted: true, contentMatches: true, secureContext: true, crossOriginIsolated: true });
  state.cleanup = { context: true, browser: true, server: true };
  return state;
}

test('window-mode reports differ only in the mode label and headless setting', () => {
  const normal = publicProbeReport(passedState('normal'));
  const headed = publicProbeReport(passedState('headed'));
  assert.equal(normal.status, 'passed');
  assert.equal(headed.status, 'passed');
  assert.equal(normal.settings.headless, true);
  assert.equal(headed.settings.headless, false);
  assert.equal(normal.settings.noWaitAfter, false);
  assert.equal(headed.settings.noWaitAfter, false);
  assert.deepEqual(headed, {
    ...normal, mode: 'headed', settings: { ...normal.settings, headless: false },
  });
});

test('a public success requires every evidence gate and valid native runner identity', () => {
  assert.equal(publicProbeReport(passedState()).status, 'passed');
  const cases = [
    state => { state.clickCompleted = false; },
    state => { state.download.saveCompleted = false; },
    state => { state.download.savedBytes = 36; },
    state => { state.contentMatches = false; },
    state => { state.cleanup.browser = false; },
    state => { state.environment.arch.browser = 'unknown'; },
    state => { state.environment.os.version = '15.7'; },
    state => { state.harnessCommit = 'not-a-commit'; },
    state => { state.secureContext = false; },
    state => { state.terminationCode = 'PROBE_PROCESS_TIMEOUT'; },
    state => { state.reportWriteFailed = true; },
  ];
  for (const change of cases) {
    const state = passedState(); change(state);
    const safe = publicProbeReport(state);
    assert.equal(safe.status, 'failed');
    assert.equal(safe.failure.code, 'PROBE_INCOMPLETE');
    assert.equal(safe.appCompatibility, 'not-tested');
  }
});

test('incremental reports contain only fixed fields and reject raw errors, URLs and paths', () => {
  const state = passedState();
  state.status = 'failed';
  state.failure = { code: 'synthetic-private-code', stage: 'synthetic-private-stage', message: 'synthetic-private-error' };
  state.url = 'https://synthetic-private.invalid';
  state.filename = 'synthetic-private-path';
  state.download.url = 'synthetic-private-blob';
  state.liveness = { samePage: { attempted: true, outcome: 'synthetic-private-outcome', raw: 'synthetic-private-stack' } };
  const safe = publicProbeReport(state);
  assert.equal(safe.failure.code, 'PROBE_UNEXPECTED_FAILURE');
  assert.equal(safe.failure.stage, 'unknown');
  assert.equal(safe.liveness.samePage.outcome, 'not-attempted');
  assert.equal(safe.fixture.bytes, 37);
  assert.match(safe.fixture.sha256, /^[a-f0-9]{64}$/);
  assert.equal(safe.comparison, 'requires-paired-review');
  assert.doesNotMatch(JSON.stringify(safe), /synthetic-private/);
});
