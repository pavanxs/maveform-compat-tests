import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import SafeReporter from '../reporters/safe-reporter.mjs';
import { newDownloadState, saveBrowserDownload, diagnoseDownloadFailure } from './downloads.mjs';
import { downloadForReport, publicFailure } from './report-utils.mjs';
import { progressForReport } from './diagnostics.mjs';

const never = () => new Promise(() => {});
const limits = { eventMs: 30, clickMs: 20, saveMs: 20, statusMs: 20, cancelMs: 10, diagnosticMs: 20 };

function fakeDownload(overrides = {}) {
  return {
    saveAs: async () => {}, failure: async () => null, cancel: async () => {},
    suggestedFilename: () => 'export.mp4', ...overrides,
  };
}
function scenario(overrides = {}) {
  const page = new EventEmitter();
  const download = fakeDownload();
  const state = newDownloadState(false, 123);
  return {
    page, download, state,
    options: {
      page, state, filename: 'unused-test-output.mp4', timeouts: limits,
      getSavedBytes: () => 123, click: async () => { page.emit('download', download); },
      ...overrides,
    },
  };
}
async function rejectsCode(operation, code) {
  await assert.rejects(operation, error => error.code === code && error.message === code);
}

test('a successful download requires event, saved bytes and browser completion in order', { timeout: 1000 }, async () => {
  const sample = scenario();
  const phases = [];
  let diagnosticCalls = 0;
  await saveBrowserDownload({
    ...sample.options, onPhase: phase => phases.push(phase),
    onFailure: () => { diagnosticCalls++; },
  });
  assert.deepEqual(phases, ['event', 'save', 'status', 'complete']);
  assert.equal(sample.state.eventReceived, true);
  assert.equal(sample.state.saveCompleted, true);
  assert.equal(sample.state.statusChecked, true);
  assert.equal(sample.state.browserStatus, 'completed');
  assert.equal(sample.state.savedBytes, 123);
  assert.equal(sample.state.failureCode, null);
  assert.equal(sample.state.cancelAttempted, false);
  assert.equal(diagnosticCalls, 0);
  assert.equal(sample.page.listenerCount('download'), 0);
});

test('a missing event fails and detaches its listener before any diagnostic download', { timeout: 1000 }, async () => {
  const sample = scenario({ click: async () => {} });
  await rejectsCode(() => saveBrowserDownload({
    ...sample.options,
    onFailure: () => {
      assert.equal(sample.page.listenerCount('download'), 0);
      sample.page.emit('download', fakeDownload());
    },
  }), 'DOWNLOAD_EVENT_TIMEOUT');
  assert.equal(sample.state.eventReceived, false);
  assert.equal(sample.state.failureDiagnosticsCompleted, true);
  assert.equal(sample.state.phase, 'event');
});

test('a received event is retained and cancelled when its click never finishes', { timeout: 1000 }, async () => {
  const sample = scenario();
  let saves = 0, cancellations = 0;
  sample.download.saveAs = async () => { saves++; };
  sample.download.cancel = async () => { cancellations++; };
  await rejectsCode(() => saveBrowserDownload({
    ...sample.options,
    click: () => { sample.page.emit('download', sample.download); return never(); },
  }), 'DOWNLOAD_CLICK_TIMEOUT');
  assert.equal(sample.state.eventReceived, true);
  assert.equal(sample.state.saveCompleted, false);
  assert.equal(sample.state.cancelAttempted, true);
  assert.equal(sample.state.cancelCompleted, true);
  assert.equal(cancellations, 1);
  assert.equal(saves, 0);
  assert.equal(sample.page.listenerCount('download'), 0);
});

test('an immediate click failure retains the event and clears the pending event wait', { timeout: 1000 }, async () => {
  const sample = scenario();
  await rejectsCode(() => saveBrowserDownload({
    ...sample.options,
    click: async () => {
      sample.page.emit('download', sample.download);
      throw new Error('synthetic private click detail');
    },
  }), 'DOWNLOAD_CLICK_FAILED');
  assert.equal(sample.state.eventReceived, true);
  assert.equal(sample.state.cancelCompleted, true);
  assert.equal(sample.page.listenerCount('download'), 0);
  assert.doesNotMatch(JSON.stringify(sample.state), /private click/);
});

test('a click failure before any event removes the primary listener before controls run', { timeout: 1000 }, async () => {
  const sample = scenario({ click: async () => { throw new Error('synthetic private click failure'); } });
  await rejectsCode(() => saveBrowserDownload({
    ...sample.options,
    onFailure: () => {
      assert.equal(sample.page.listenerCount('download'), 0);
      sample.page.emit('download', fakeDownload());
    },
  }), 'DOWNLOAD_CLICK_FAILED');
  assert.equal(sample.state.eventReceived, false);
  assert.equal(sample.state.cancelAttempted, false);
  assert.equal(sample.state.failureDiagnosticsCompleted, true);
  assert.equal(sample.state.phase, 'event');
  assert.doesNotMatch(JSON.stringify(sample.state), /private click/);
});

test('a save that completes after its deadline cannot promote the failed download to success', { timeout: 1000 }, async () => {
  const sample = scenario();
  let resolveSave;
  sample.download.saveAs = () => new Promise(resolve => { resolveSave = resolve; });
  await rejectsCode(() => saveBrowserDownload(sample.options), 'DOWNLOAD_SAVE_TIMEOUT');
  resolveSave();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sample.state.saveCompleted, false);
  assert.equal(sample.state.statusChecked, false);
  assert.equal(sample.state.phase, 'save');
  assert.equal(sample.state.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
  assert.equal(sample.state.cancelCompleted, true);
});

test('a stuck save and stuck cancellation are both bounded and remain a failure', { timeout: 1000 }, async () => {
  const sample = scenario();
  sample.download.saveAs = never;
  sample.download.cancel = never;
  await rejectsCode(() => saveBrowserDownload({
    ...sample.options,
    onFailure: state => { state.control = { completed: true, contentMatches: true }; },
  }), 'DOWNLOAD_SAVE_TIMEOUT');
  assert.equal(sample.state.phase, 'save');
  assert.equal(sample.state.eventReceived, true);
  assert.equal(sample.state.saveCompleted, false);
  assert.equal(sample.state.cancelAttempted, true);
  assert.equal(sample.state.cancelCompleted, false);
  assert.equal(sample.state.failureDiagnosticsCompleted, true);
  assert.equal(sample.state.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
});

test('a stuck browser completion check has a distinct bounded failure', { timeout: 1000 }, async () => {
  const sample = scenario();
  sample.download.failure = never;
  await rejectsCode(() => saveBrowserDownload(sample.options), 'DOWNLOAD_STATUS_TIMEOUT');
  assert.equal(sample.state.phase, 'status');
  assert.equal(sample.state.saveCompleted, true);
  assert.equal(sample.state.statusChecked, false);
  assert.equal(sample.state.cancelCompleted, true);
});

test('browser errors and byte mismatches cannot pass even after saveAs completes', { timeout: 1000 }, async () => {
  const broken = scenario();
  broken.download.failure = async () => 'synthetic secret URL or local path';
  await rejectsCode(() => saveBrowserDownload(broken.options), 'DOWNLOAD_FAILED');
  assert.equal(broken.state.browserStatus, 'failed');
  assert.equal(broken.state.statusChecked, true);
  assert.doesNotMatch(JSON.stringify(broken.state), /secret URL|local path/);
  const mismatch = scenario({ getSavedBytes: () => 122 });
  await rejectsCode(() => saveBrowserDownload(mismatch.options), 'EXPORT_METADATA_MISMATCH');
  assert.equal(mismatch.state.savedBytes, 122);
  assert.equal(mismatch.state.phase, 'status');
});

for (const behavior of ['throw', 'hang']) {
  test('a diagnostic that can ' + behavior + ' never replaces the primary error', { timeout: 1000 }, async () => {
    const sample = scenario();
    sample.download.saveAs = never;
    await rejectsCode(() => saveBrowserDownload({
      ...sample.options,
      onFailure: behavior === 'hang' ? never : () => { throw new Error('synthetic private diagnostic detail'); },
    }), 'DOWNLOAD_SAVE_TIMEOUT');
    assert.equal(sample.state.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
    assert.equal(sample.state.failureDiagnosticsAttempted, true);
    assert.equal(sample.state.failureDiagnosticsCompleted, false);
    assert.equal(sample.state.diagnosticFailureCode, behavior === 'hang' ? 'DOWNLOAD_DIAGNOSTIC_TIMEOUT' : 'DOWNLOAD_DIAGNOSTIC_FAILED');
  });
}

test('a late original MP4 cannot satisfy the text-control download wait', { timeout: 1000 }, async () => {
  const sample = scenario();
  let lateCancelled = 0;
  const late = fakeDownload({ cancel: async () => { lateCancelled++; } });
  const control = fakeDownload({ suggestedFilename: () => 'maveform-download-control.txt' });
  await saveBrowserDownload({
    ...sample.options,
    accept: download => download.suggestedFilename() === 'maveform-download-control.txt',
    click: async () => {
      sample.page.emit('download', late);
      sample.page.emit('download', control);
    },
  });
  assert.equal(sample.state.ignoredDownloads, 1);
  assert.equal(lateCancelled, 1);
  assert.equal(sample.state.eventReceived, true);
  assert.equal(sample.state.phase, 'complete');
});

function controlScenario({ wrongText = false, blobError = false } = {}) {
  const sample = scenario();
  let text = '', downloadName = '', testId = '';
  sample.page.evaluate = async (_callback, argument) => {
    if (typeof argument === 'number') {
      if (blobError) throw new Error('synthetic private blob URL');
      return { readable: true, bytes: argument, matchesExpectedBytes: true, mimeType: 'video/mp4', failureCode: null };
    }
    if (typeof argument === 'object') {
      ({ text, downloadName, testId } = argument);
      return;
    }
    assert.equal(argument, testId);
  };
  sample.page.getByTestId = requestedId => ({
    click: async ({ timeout }) => {
      assert.equal(requestedId, testId);
      assert.ok(timeout > 0);
      sample.page.emit('download', fakeDownload({
        suggestedFilename: () => downloadName,
        saveAs: async filename => writeFileSync(filename, wrongText ? 'X' + text.slice(1) : text),
      }));
    },
  });
  return sample;
}
function temporaryControl() {
  const base = path.resolve('node_modules/.cache/maveform-compat-checks');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(path.join(base, 'download-regression-'));
  return { filename: path.join(folder, 'control.txt'), cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test('readable export Blob and successful real-file text control remain failure-only evidence', { timeout: 1500 }, async () => {
  const sample = controlScenario();
  const local = temporaryControl();
  sample.download.saveAs = never;
  try {
    await rejectsCode(() => saveBrowserDownload({
      ...sample.options, timeouts: { ...limits, diagnosticMs: 500 },
      onFailure: state => diagnoseDownloadFailure({ page: sample.page, expectedBytes: 123, controlFilename: local.filename, state }),
    }), 'DOWNLOAD_SAVE_TIMEOUT');
    assert.equal(sample.state.blob.readable, true);
    assert.equal(sample.state.blob.matchesExpectedBytes, true);
    assert.equal(sample.state.control.completed, true);
    assert.equal(sample.state.control.contentMatches, true);
    assert.equal(sample.state.control.cleanupCompleted, true);
    assert.equal(sample.state.phase, 'save');
    assert.equal(sample.state.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
  } finally { local.cleanup(); }
});

test('broken Blob probe and wrong text-control content retain fixed separate failure details', { timeout: 1500 }, async () => {
  const sample = controlScenario({ wrongText: true, blobError: true });
  const local = temporaryControl();
  try {
    sample.state.failureCode = 'DOWNLOAD_SAVE_TIMEOUT';
    await diagnoseDownloadFailure({ page: sample.page, expectedBytes: 123, controlFilename: local.filename, state: sample.state });
    assert.equal(sample.state.blob.failureCode, 'DOWNLOAD_BLOB_PROBE_FAILED');
    assert.equal(sample.state.control.completed, false);
    assert.equal(sample.state.control.contentMatches, false);
    assert.equal(sample.state.control.failureCode, 'DOWNLOAD_CONTROL_CONTENT_MISMATCH');
    assert.equal(sample.state.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
    assert.doesNotMatch(JSON.stringify(sample.state), /private blob URL/);
  } finally { local.cleanup(); }
});

test('public download details keep fixed states and numbers while discarding arbitrary strings', () => {
  const raw = {
    ...newDownloadState(true, 123), phase: 'save', failureCode: 'DOWNLOAD_SAVE_TIMEOUT',
    url: 'https://synthetic-private.invalid', filename: 'synthetic-private-file', rawError: 'synthetic-private-error',
    blob: { attempted: true, readable: true, bytes: 123, matchesExpectedBytes: true, mimeType: 'video/mp4', url: 'synthetic-private-blob' },
    control: { ...newDownloadState(null, 36), attempted: true, completed: true, contentMatches: true, filename: 'synthetic-private-path', control: { raw: 'synthetic-private-nested' } },
  };
  const safe = downloadForReport(raw);
  assert.equal(safe.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
  assert.equal(safe.captions, true);
  assert.equal(safe.blob.bytes, 123);
  assert.equal(safe.control.contentMatches, true);
  assert.doesNotMatch(JSON.stringify(safe), /synthetic-private/);
  assert.equal(downloadForReport(null), null);
  const invalid = downloadForReport({ phase: 'synthetic-private-stage', failureCode: 'synthetic-private-code', expectedBytes: -1, blob: { mimeType: 'synthetic-private-mime' } });
  assert.equal(invalid.phase, 'unknown');
  assert.equal(invalid.failureCode, null);
  assert.equal(invalid.expectedBytes, null);
  assert.equal(invalid.blob.mimeType, null);
  for (const captions of ['off', 'on']) {
    for (const phase of ['event', 'save', 'status', 'complete']) {
      const stage = 'download-' + phase + '-captions-' + captions;
      const progress = progressForReport('media-smoke', { stage, download: raw }, {});
      assert.equal(progress.stage, stage);
      assert.equal(progress.download.failureCode, 'DOWNLOAD_SAVE_TIMEOUT');
      assert.doesNotMatch(JSON.stringify(progress), /synthetic-private/);
    }
  }
});

test('safe reporter sanitizes download attachments and retains precise failure stages', () => {
  const reporter = new SafeReporter();
  const diagnostics = {
    stage: 'download-save-captions-on', runtimeEnvironment: null,
    download: { ...newDownloadState(true, 123), failureCode: 'DOWNLOAD_SAVE_TIMEOUT', url: 'synthetic-private-url' },
  };
  reporter.onTestEnd({ title: 'controlled download failure', expectedStatus: 'passed', location: { file: 'media.smoke.spec.mjs' } }, {
    status: 'failed', duration: 1, error: new Error('DOWNLOAD_SAVE_TIMEOUT'),
    attachments: [{ name: 'safe-diagnostics', body: Buffer.from(JSON.stringify(diagnostics)) }],
  });
  assert.equal(reporter.tests[0].failure.code, 'DOWNLOAD_SAVE_TIMEOUT');
  assert.equal(reporter.tests[0].failure.stage, 'download-save-captions-on');
  assert.equal(reporter.tests[0].diagnostics.download.captions, true);
  assert.doesNotMatch(JSON.stringify(reporter.tests[0]), /synthetic-private/);
  for (const code of ['DOWNLOAD_EVENT_TIMEOUT', 'DOWNLOAD_CLICK_TIMEOUT', 'DOWNLOAD_SAVE_TIMEOUT', 'DOWNLOAD_STATUS_TIMEOUT', 'DOWNLOAD_DIAGNOSTIC_TIMEOUT', 'DOWNLOAD_BLOB_PROBE_TIMEOUT', 'DOWNLOAD_CONTROL_SETUP_TIMEOUT']) {
    assert.equal(publicFailure(new Error(code)).code, code);
  }
});
