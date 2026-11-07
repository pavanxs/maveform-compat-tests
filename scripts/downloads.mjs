import { readFileSync, statSync } from 'node:fs';
import { withDeadline, boundedCleanup } from './diagnostics.mjs';

export const DOWNLOAD_TIMEOUTS = Object.freeze({
  eventMs: 20_000, clickMs: 10_000, saveMs: 30_000, statusMs: 5000,
  cancelMs: 1000, diagnosticMs: 15_000,
});
const CONTROL_TEXT = 'Maveform synthetic download control.\n';
const CONTROL_FILENAME = 'maveform-download-control.txt';
const CONTROL_TEST_ID = 'compat-download-control';

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
async function timed(operation, timeoutMs, timeoutCode, fallbackCode = 'DOWNLOAD_FAILED') {
  try { return await withDeadline(operation, timeoutMs, timeoutCode); }
  catch (error) {
    throw failure(error?.code === timeoutCode || /timeout|timed out/i.test(String(error?.message || '')) ? timeoutCode : fallbackCode);
  }
}
export function newDownloadState(captions, expectedBytes) {
  return {
    captions, phase: 'event', expectedBytes, savedBytes: null,
    eventReceived: false, saveCompleted: false, statusChecked: false, browserStatus: null,
    cancelAttempted: false, cancelCompleted: false, ignoredDownloads: 0,
    failureCode: null, failureDiagnosticsAttempted: false, failureDiagnosticsCompleted: false,
    diagnosticFailureCode: null, blob: null, control: null,
  };
}
function downloadWaiter(page, accept, onReceived, onIgnored) {
  let listener, settle, disposed = false;
  const promise = new Promise(resolve => {
    settle = resolve;
    listener = download => {
      if (disposed) return;
      let accepted = false;
      try { accepted = accept(download); } catch { /* Invalid events cannot satisfy this wait. */ }
      if (!accepted) { onIgnored(download); return; }
      disposed = true;
      page.off('download', listener);
      // Capture the resource before the click promise can reject or time out.
      onReceived(download);
      resolve(download);
    };
    page.on('download', listener);
  });
  return { promise, dispose() {
    if (!disposed) {
      disposed = true;
      page.off('download', listener);
      // Settle a pending event wait so its timer cannot outlive an early click failure.
      settle(null);
    }
  } };
}

export async function saveBrowserDownload({
  page, click, filename, state, onPhase = () => {}, onUpdate = () => {},
  accept = () => true, getSavedBytes = () => statSync(filename).size,
  timeouts = {}, onFailure = null,
}) {
  const limits = { ...DOWNLOAD_TIMEOUTS, ...timeouts };
  let download;
  const phase = name => { state.phase = name; onPhase(name); onUpdate(); };
  const waiter = downloadWaiter(page, accept, received => {
    download = received;
    state.eventReceived = true;
    onUpdate();
  }, ignored => {
    state.ignoredDownloads++;
    onUpdate();
    void boundedCleanup(() => ignored.cancel(), limits.cancelMs);
  });
  try {
    phase('event');
    try {
      await Promise.all([
        timed(waiter.promise, limits.eventMs, 'DOWNLOAD_EVENT_TIMEOUT', 'DOWNLOAD_MISSING'),
        timed(() => click(limits.clickMs), limits.clickMs, 'DOWNLOAD_CLICK_TIMEOUT', 'DOWNLOAD_CLICK_FAILED'),
      ]);
    } finally {
      // Detach before failure controls, so a second download cannot satisfy this wait.
      waiter.dispose();
    }
    phase('save');
    await timed(() => download.saveAs(filename), limits.saveMs, 'DOWNLOAD_SAVE_TIMEOUT');
    state.saveCompleted = true;
    onUpdate();
    phase('status');
    const downloadError = await timed(() => download.failure(), limits.statusMs, 'DOWNLOAD_STATUS_TIMEOUT');
    state.statusChecked = true;
    state.browserStatus = downloadError === null ? 'completed' : /^cancelled?$|^canceled$/i.test(String(downloadError)) ? 'cancelled' : 'failed';
    if (downloadError !== null) throw failure('DOWNLOAD_FAILED');
    state.savedBytes = getSavedBytes();
    if (state.savedBytes !== state.expectedBytes) throw failure('EXPORT_METADATA_MISMATCH');
    phase('complete');
    return download;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^(DOWNLOAD_|EXPORT_METADATA_MISMATCH)/.test(error.code)
      ? error.code : 'DOWNLOAD_FAILED';
    const failedPhase = state.phase;
    state.failureCode = code;
    if (download) {
      state.cancelAttempted = true;
      state.cancelCompleted = await boundedCleanup(() => download.cancel(), limits.cancelMs);
    }
    onUpdate();
    if (onFailure) {
      state.failureDiagnosticsAttempted = true;
      onUpdate();
      try {
        await withDeadline(() => onFailure(state), limits.diagnosticMs, 'DOWNLOAD_DIAGNOSTIC_TIMEOUT');
        state.failureDiagnosticsCompleted = true;
      } catch (diagnosticError) {
        state.diagnosticFailureCode = diagnosticError?.code === 'DOWNLOAD_DIAGNOSTIC_TIMEOUT'
          ? 'DOWNLOAD_DIAGNOSTIC_TIMEOUT' : 'DOWNLOAD_DIAGNOSTIC_FAILED';
      }
    }
    // Neither a successful control nor a broken diagnostic can replace the primary failure.
    state.phase = failedPhase;
    state.failureCode = code;
    onUpdate();
    throw failure(code);
  } finally {
    waiter.dispose();
  }
}

async function inspectExportBlob(page, expectedBytes, state, onUpdate) {
  state.blob = { attempted: true, completed: false, readable: null, bytes: null, matchesExpectedBytes: null, mimeType: null, failureCode: null };
  onUpdate();
  try {
    const result = await withDeadline(() => page.evaluate(async expected => {
      const href = document.querySelector('[data-testid="compat-download"]')?.getAttribute('href') || '';
      if (!href.startsWith('blob:')) return { readable: false, failureCode: 'DOWNLOAD_BLOB_UNAVAILABLE' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(href, { signal: controller.signal });
        const blob = await response.blob();
        return {
          readable: true, bytes: blob.size, matchesExpectedBytes: blob.size === expected,
          mimeType: ['video/mp4', 'text/plain', 'application/octet-stream'].includes(blob.type) ? blob.type : 'other',
          failureCode: null,
        };
      } catch { return { readable: false, failureCode: 'DOWNLOAD_BLOB_UNAVAILABLE' }; }
      finally { clearTimeout(timer); }
    }, expectedBytes), 3000, 'DOWNLOAD_BLOB_PROBE_TIMEOUT');
    Object.assign(state.blob, result, { completed: true });
  } catch (error) {
    state.blob.failureCode = error?.code === 'DOWNLOAD_BLOB_PROBE_TIMEOUT' ? error.code : 'DOWNLOAD_BLOB_PROBE_FAILED';
  }
  onUpdate();
}

async function inspectControlDownload(page, filename, state, onUpdate) {
  const control = newDownloadState(null, Buffer.byteLength(CONTROL_TEXT));
  Object.assign(control, { attempted: true, completed: false, contentMatches: null, cleanupCompleted: false, phase: 'setup' });
  state.control = control;
  onUpdate();
  try {
    await withDeadline(() => page.evaluate(({ text, downloadName, testId }) => {
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      anchor.download = downloadName;
      anchor.dataset.testid = testId;
      anchor.textContent = 'Download test file';
      Object.assign(anchor.style, { position: 'fixed', top: '8px', left: '8px', zIndex: '2147483647', background: 'white', color: 'black', padding: '12px' });
      document.body.appendChild(anchor);
    }, { text: CONTROL_TEXT, downloadName: CONTROL_FILENAME, testId: CONTROL_TEST_ID }), 2000, 'DOWNLOAD_CONTROL_SETUP_TIMEOUT');
    await saveBrowserDownload({
      page, filename, state: control, onUpdate,
      // A trusted locator click supplies the same user activation as the real anchor.
      click: timeout => page.getByTestId(CONTROL_TEST_ID).click({ timeout }),
      accept: download => download.suggestedFilename() === CONTROL_FILENAME,
      timeouts: { eventMs: 3000, clickMs: 3000, saveMs: 3000, statusMs: 1000, cancelMs: 500 },
    });
    control.contentMatches = readFileSync(filename, 'utf8') === CONTROL_TEXT;
    if (!control.contentMatches) throw failure('DOWNLOAD_CONTROL_CONTENT_MISMATCH');
    control.completed = true;
  } catch (error) {
    control.failureCode = typeof error?.code === 'string' && error.code.startsWith('DOWNLOAD_') ? error.code : 'DOWNLOAD_CONTROL_FAILED';
  } finally {
    control.cleanupCompleted = await boundedCleanup(() => page.evaluate(testId => {
      const anchor = document.querySelector('[data-testid="' + testId + '"]');
      if (anchor) { URL.revokeObjectURL(anchor.href); anchor.remove(); }
    }, CONTROL_TEST_ID));
    onUpdate();
  }
}

export async function diagnoseDownloadFailure({ page, expectedBytes, controlFilename, state, onUpdate = () => {} }) {
  // These controls only explain a failure. They never provide media to the MP4 validator.
  await inspectExportBlob(page, expectedBytes, state, onUpdate);
  await inspectControlDownload(page, controlFilename, state, onUpdate);
}
