import { test as base, expect } from '@playwright/test';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  capabilitiesForReport, snapshotForReport, runtimeFailure, safeBuildId, publicFailure,
} from '../scripts/report-utils.mjs';
import { collectRuntimeEnvironment } from '../scripts/runtime-environment.mjs';
import { collectReportContext } from '../scripts/report-context.mjs';
import { withDeadline, boundedCleanup, writeCheckpoint, checkIdForFile } from '../scripts/diagnostics.mjs';

export { expect };

export function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

export function fixture(kind = 'smoke') {
  const manifestPath = path.resolve('.generated/manifest.json');
  ensure(existsSync(manifestPath), 'FIXTURE_MISSING');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  ensure(manifest.syntheticOnly === true && manifest[kind], 'FIXTURE_INVALID');
  const file = path.resolve('.generated', kind === 'speech' ? 'synthetic-speech.mp4' : 'synthetic-smoke.mp4');
  ensure(existsSync(file), 'FIXTURE_MISSING');
  return { file, info: manifest[kind], generation: manifest.generation };
}

export const test = base.extend({
  _compatWorkerProgress: [async ({}, use) => {
    const context = collectReportContext();
    writeCheckpoint('worker', { stage: 'browser-launch' }, context);
    await use();
  }, { scope: 'worker', auto: true }],
  _compatBrowserReady: [async ({ _compatWorkerProgress, browser }, use) => {
    const context = collectReportContext();
    writeCheckpoint('worker', { stage: 'browser-ready' }, context);
    try { await use(); }
    finally { writeCheckpoint('worker', { stage: 'browser-teardown' }, context); }
  }, { scope: 'worker', auto: true }],
  _compatPageProgress: [async ({}, use, testInfo) => {
    writeCheckpoint(checkIdForFile(testInfo.file), { stage: 'page-setup' }, collectReportContext());
    await use();
  }, { auto: true }],
  compat: async ({ _compatPageProgress, page, browser }, use, testInfo) => {
    const diagnostics = {
      stage: 'runtime-environment', browserVersion: browser.version(), capabilities: null,
      snapshot: null, fixture: null, sourceBrowserDecode: null, exports: [],
      captions: null, models: { attempted: false, completed: false }, pageErrorCount: 0, consoleErrorCount: 0,
      failure: null, buildId: null, identityVerified: false,
      runtimeEnvironment: null,
      reportContext: collectReportContext(),
    };
    page.on('pageerror', () => { diagnostics.pageErrorCount++; });
    page.on('console', message => { if (message.type() === 'error') diagnostics.consoleErrorCount++; });
    const compat = {
      page, diagnostics, testInfo,
      checkpoint() { return writeCheckpoint(checkIdForFile(testInfo.file), diagnostics, diagnostics.reportContext); },
      stage(name) { diagnostics.stage = name; this.checkpoint(); },
      async call(method, args = [], fallbackCode = 'COMPAT_METHOD_MISSING') {
        const request = () => page.evaluate(async ({ method, args }) => {
          const bridge = window.__MAVEFORM_COMPAT__;
          if (!bridge || typeof bridge[method] !== 'function') return { ok: false, missing: true };
          try { return { ok: true, value: await bridge[method](...args) }; }
          catch (error) {
            return { ok: false, message: String(error?.message || error) };
          }
        }, { method, args });
        const result = method === 'snapshot' ? await withDeadline(request, 5000, 'SNAPSHOT_TIMEOUT') :
          method === 'capabilities' ? await withDeadline(request, 20_000, 'CAPABILITY_PROBE_TIMEOUT') : await request();
        if (!result.ok) throw new Error(result.missing ? 'COMPAT_METHOD_MISSING' : runtimeFailure(result.message, fallbackCode));
        return result.value;
      },
      async snapshot() {
        const raw = await this.call('snapshot');
        diagnostics.snapshot = snapshotForReport(raw);
        this.checkIdentity(raw.buildId);
        return raw;
      },
      checkIdentity(buildId) {
        ensure(safeBuildId(buildId), 'BUILD_ID_MISSING');
        const expected = process.env.MAVEFORM_EXPECTED_BUILD_ID?.trim();
        if (expected) ensure(buildId === expected, 'BUILD_ID_MISMATCH');
        if (diagnostics.buildId) ensure(diagnostics.buildId === buildId, 'BUILD_ID_CHANGED_DURING_RUN');
        diagnostics.buildId = buildId;
        diagnostics.identityVerified = Boolean(expected && buildId === expected);
        this.checkpoint();
      },
      async open() {
        this.stage('navigation');
        let response;
        try { response = await page.goto('/compatibility/', { waitUntil: 'domcontentloaded' }); }
        catch { throw new Error('NAVIGATION_FAILED'); }
        ensure(response?.ok(), 'PREVIEW_ROUTE_UNAVAILABLE');
        const current = new URL(page.url());
        const target = new URL(process.env.MAVEFORM_BASE_URL);
        ensure(current.origin === target.origin && /^\/compatibility\/?$/.test(current.pathname), 'PREVIEW_ROUTE_UNAVAILABLE');
        try {
          await page.waitForFunction(() => window.__MAVEFORM_COMPAT__?.version === 1, undefined, { timeout: 15_000 });
        } catch { throw new Error('COMPAT_CONTRACT_MISSING'); }
        this.stage('identity');
        await this.snapshot();
        this.stage('capabilities');
        const capabilities = await this.call('capabilities', [], 'CAPABILITY_PROBE_FAILED');
        diagnostics.capabilities = capabilitiesForReport(capabilities);
        await this.snapshot();
      },
      requireExportCapabilities() {
        const capabilities = diagnostics.capabilities;
        ensure(capabilities?.videoDecoder === true, 'VIDEO_DECODER_UNAVAILABLE');
        ensure(capabilities?.videoEncoder === true, 'VIDEO_ENCODER_UNAVAILABLE');
        ensure(capabilities?.avcEncode !== false, 'H264_ENCODE_UNAVAILABLE');
      },
      async upload(kind = 'smoke') {
        this.stage('source-upload');
        const selected = fixture(kind);
        diagnostics.fixture = {
          kind, sha256: selected.info.sha256, bytes: selected.info.bytes,
          durationS: selected.info.durationS, width: selected.info.width, height: selected.info.height,
          videoCodec: selected.info.videoCodec, audioCodec: selected.info.audioCodec,
          generator: selected.generation,
        };
        await page.getByTestId('compat-video').setInputFiles(selected.file);
        try {
          await page.waitForFunction(() => {
            const status = window.__MAVEFORM_COMPAT__?.snapshot().sourceStatus;
            return status === 'ready' || status === 'error';
          }, undefined, { timeout: 30_000 });
        } catch { throw new Error('SOURCE_LOAD_TIMEOUT'); }
        const loaded = await this.snapshot();
        ensure(loaded.sourceStatus === 'ready', 'SOURCE_LOAD_FAILED');
        ensure(loaded.source?.width === selected.info.width && loaded.source?.height === selected.info.height, 'SOURCE_METADATA_MISMATCH');
        ensure(Math.abs(loaded.source.durationS - selected.info.durationS) < 0.2, 'SOURCE_METADATA_MISMATCH');
        this.stage('browser-source-decode');
        let decoded;
        try {
          decoded = await page.getByTestId('compat-source-preview').evaluate(async video => {
            video.muted = true;
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('decode timeout')), 15_000);
              const done = () => { clearTimeout(timer); video.removeEventListener('error', failed); resolve(); };
              const failed = () => { clearTimeout(timer); video.removeEventListener('seeked', done); reject(new Error('decode failed')); };
              video.addEventListener('seeked', done, { once: true });
              video.addEventListener('error', failed, { once: true });
              video.currentTime = 1;
            });
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 36;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('canvas unavailable');
            context.drawImage(video, 0, 0, 64, 36);
            const pixels = context.getImageData(0, 0, 64, 36).data;
            let bright = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 100) bright++;
            return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, brightFraction: bright / (64 * 36) };
          });
        } catch { throw new Error('SOURCE_BROWSER_DECODE_FAILED'); }
        diagnostics.sourceBrowserDecode = decoded;
        ensure(decoded.brightFraction > 0.1, 'SOURCE_BROWSER_FRAME_BLANK');
        return selected;
      },
      async export(captions) {
        this.stage(captions ? 'export-captions-on' : 'export-captions-off');
        const artifact = await this.call('exportClip', [{ startS: 0.5, endS: 2.5, captions }], 'EXPORT_FAILED');
        this.checkIdentity(artifact.buildId);
        const saved = await this.snapshot();
        ensure(saved.models?.phase === 'not-run', 'UNEXPECTED_MODEL_RUN');
        this.stage('download');
        let download;
        try {
          [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 20_000 }),
            page.getByTestId('compat-download').click(),
          ]);
        } catch { throw new Error('DOWNLOAD_MISSING'); }
        const filename = this.testInfo.outputPath(captions ? 'captions-on.mp4' : 'captions-off.mp4');
        try { await download.saveAs(filename); } catch { throw new Error('DOWNLOAD_FAILED'); }
        ensure(await download.failure() === null, 'DOWNLOAD_FAILED');
        ensure(statSync(filename).size === artifact.bytes, 'EXPORT_METADATA_MISMATCH');
        return { file: filename, artifact: snapshotForReport({ export: { artifact } }).export.artifact };
      },
    };
    compat.checkpoint();
    try {
      diagnostics.runtimeEnvironment = await collectRuntimeEnvironment({
        browser, channel: testInfo.project.use.channel || 'webkit',
        onStage: stage => compat.stage(stage),
      });
      compat.checkpoint();
      ensure(!['unknown', 'universal'].includes(diagnostics.runtimeEnvironment.arch.browser), 'BROWSER_ARCHITECTURE_UNKNOWN');
      ensure(diagnostics.runtimeEnvironment.arch.host === diagnostics.runtimeEnvironment.arch.node &&
        diagnostics.runtimeEnvironment.arch.host === diagnostics.runtimeEnvironment.arch.browser, 'BROWSER_ARCHITECTURE_MISMATCH');
      await use(compat);
    } catch (error) {
      diagnostics.failure = publicFailure(error, diagnostics.stage);
      throw error;
    } finally {
      try {
        const final = await withDeadline(() => page.evaluate(() => window.__MAVEFORM_COMPAT__?.snapshot()), 2000, 'SNAPSHOT_TIMEOUT');
        if (final) diagnostics.snapshot = snapshotForReport(final);
      } catch { /* Closed/crashed browser is represented by test failure, not hidden. */ }
      if (testInfo.status !== 'passed' && !diagnostics.failure) diagnostics.failure = publicFailure(testInfo.error, diagnostics.stage);
      compat.checkpoint();
      await boundedCleanup(() => testInfo.attach('safe-diagnostics', {
        body: Buffer.from(JSON.stringify(diagnostics)), contentType: 'application/json',
      }), 2000);
    }
  },
});
