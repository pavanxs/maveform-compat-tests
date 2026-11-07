import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, validateExpectedBuildId } from './target.mjs';
import { MATRIX, REQUIRED_CHECKS, evaluateMatrix as evaluateRaw } from './matrix.mjs';
import { compareCaptionFrames } from './validate-media.mjs';
import { validateCoreResult } from './validate-models.mjs';
import { capabilitiesForReport, snapshotForReport, publicFailure } from './report-utils.mjs';

const evaluateMatrix = (cells, suite = 'smoke') => evaluateRaw(cells, suite, 'sha-012345');

function passingCells(suite = 'smoke') {
  return MATRIX.map(cell => ({
    cellId: cell.id, suite, status: 'passed', buildId: 'sha-012345',
    expectedBuildId: 'sha-012345', identityVerified: true, runId: '17', runAttempt: '1',
    environment: { arch: cell.arch, os: cell.os, browser: cell.browser, runner: cell.runner },
    failureCode: null, frameworkErrors: [],
    tests: REQUIRED_CHECKS[suite].map(checkId => ({
      checkId, status: 'passed', failure: null,
      diagnostics: { buildId: 'sha-012345', identityVerified: true },
    })),
  }));
}

test('CI needs HTTPS without credentials or URL-carried secrets', () => {
  assert.equal(validateTarget('https://preview.example.com/', { ci: true }), 'https://preview.example.com');
  for (const value of ['', 'http://example.com', 'http://localhost:3035', 'https://user:password@example.com', 'https://example.com/?token=secret', 'https://example.com/#secret', 'https://example.com/private/path']) {
    assert.throws(() => validateTarget(value, { ci: true }));
  }
  assert.equal(validateTarget('http://localhost:3035', { ci: false }), 'http://localhost:3035');
});

test('CI rejects missing build identity and path-like identifiers', () => {
  assert.throws(() => validateExpectedBuildId(undefined, { ci: true }), /BUILD_ID_REQUIRED/);
  assert.throws(() => validateExpectedBuildId('private/branch', { ci: true }), /BUILD_ID_INVALID/);
  assert.equal(validateExpectedBuildId('abcdef0123', { ci: true }), 'abcdef0123');
  assert.equal(validateExpectedBuildId(undefined, { ci: false }), null);
});

test('every requested runner must pass; missing or skipped cells fail', () => {
  assert.equal(evaluateMatrix(passingCells()).status, 'passed');
  assert.equal(evaluateMatrix(passingCells().slice(1)).status, 'failed');
  const skipped = passingCells();
  skipped[3].tests[0].status = 'skipped';
  assert.equal(evaluateMatrix(skipped).status, 'failed');
});

test('mixed builds, wrong architecture, unverified IDs and duplicate reports fail', () => {
  for (const change of [
    cells => { cells[1].buildId = 'different'; },
    cells => { cells[2].environment.arch = 'x64'; },
    cells => { cells[0].identityVerified = false; },
    cells => { cells.push(cells[0]); },
    cells => { cells[1].runAttempt = '2'; },
  ]) {
    const cells = passingCells();
    change(cells);
    assert.equal(evaluateMatrix(cells).status, 'failed');
  }
});

test('the manual models suite cannot pass with smoke-only reports', () => {
  assert.equal(evaluateMatrix(passingCells(), 'models').status, 'failed');
});

test('public snapshots omit video names, URLs, secret fields and raw failures', () => {
  const value = snapshotForReport({
    version: 1, buildId: 'abc', mode: 'deterministic-media', sourceStatus: 'error',
    source: { name: 'private-client.mp4', url: 'https://secret.example.com?token=abc', bytes: 100, width: 320, height: 180, durationS: 3 },
    sourceError: 'private implementation failed at C:\\private\\source.ts with secret=123',
    export: { error: 'secret-key-987', artifact: { url: 'blob:secret', filename: 'private.mp4', bytes: 500 } },
    models: { error: 'private database URL' }, token: 'never-publish',
  });
  const text = JSON.stringify(value);
  for (const forbidden of ['private', 'secret', 'never-publish', 'blob:', '.mp4']) assert.equal(text.includes(forbidden), false);
  assert.equal(value.sourceErrorCode, 'SOURCE_LOAD_FAILED');
});

test('capability and test errors retain codes without raw implementation text', () => {
  const caps = capabilitiesForReport({ videoDecoder: false, probeErrors: ['VideoDecoder unavailable at C:\\private\\file.js'], token: 'secret' });
  assert.equal(caps.videoDecoder, false);
  assert.deepEqual(caps.probeErrorCodes, ['VIDEO_DECODER_UNAVAILABLE']);
  assert.equal(JSON.stringify(caps).includes('private'), false);
  assert.deepEqual(publicFailure(new Error('EXPORT_FAILED: secret URL'), 'export'), { code: 'EXPORT_FAILED', stage: 'export' });
});

test('caption comparison rejects source motion outside the caption band', () => {
  const before = Buffer.alloc(135 * 240 * 3, 25);
  const after = Buffer.from(before);
  after.fill(230, 135 * 82 * 3, 135 * 158 * 3);
  assert.throws(() => compareCaptionFrames(before, after), /CAPTIONS_NOT_VISIBLE/);
});

test('caption comparison rejects mild codec noise and global brightness changes', () => {
  const before = Buffer.alloc(135 * 240 * 3, 30);
  assert.throws(() => compareCaptionFrames(before, Buffer.alloc(before.length, 32)), /CAPTIONS_NOT_VISIBLE/);
  assert.throws(() => compareCaptionFrames(before, Buffer.alloc(before.length, 200)), /CAPTIONS_NOT_VISIBLE/);
});

test('caption comparison accepts localized white and gold strokes despite mild noise', () => {
  const before = Buffer.alloc(135 * 240 * 3, 30);
  const after = Buffer.alloc(before.length, 32);
  for (let y = 175; y < 196; y++) {
    for (let x = 25; x < 110; x++) {
      if ((x % 9) > 3 && y > 179 && y < 192) continue;
      const i = (y * 135 + x) * 3;
      after[i] = 250; after[i + 1] = 210; after[i + 2] = 20;
    }
  }
  const compared = compareCaptionFrames(before, after);
  assert.ok(compared.captionDelta > compared.controlDelta * 3);
  assert.ok(compared.newCaptionColorPixels > 12);
});

function coreResult() {
  return {
    words: Array.from({ length: 25 }, (_, i) => ({ text: ['browser', 'video', 'clips', 'captions', 'recording'][i % 5], start: i, end: i + 0.5 })),
    sentences: [
      { id: 's1', startS: 0, endS: 12, words: [] },
      { id: 's2', startS: 12, endS: 25, words: [] },
    ],
    embeddedSentenceIds: ['s1', 's2'], embeddingCount: 2,
    clips: [{ id: 'c1', source: 'atlas', startS: 0, endS: 25, durationS: 25 }],
    atlasDevice: 'wasm', preferredTranscriptionDevice: 'wasm',
    optionalLanes: { faceDetection: 'not-run', sceneDetection: 'not-run', genesis: 'not-run' },
  };
}
const speechInfo = { durationS: 32, expectedWords: ['browser', 'video', 'clips', 'captions', 'recording'] };

test('real model validation requires coverage of every unique sentence', () => {
  assert.equal(validateCoreResult(coreResult(), speechInfo).coverage.sentencesCovered, 2);
  const partial = coreResult();
  partial.embeddedSentenceIds = ['s1'];
  partial.embeddingCount = 1;
  assert.throws(() => validateCoreResult(partial, speechInfo), /MODEL_EMBEDDINGS_INCOMPLETE/);
});

test('duplicate sentence or embedding IDs cannot fake full model coverage', () => {
  const duplicatedSentences = coreResult();
  duplicatedSentences.sentences[1].id = 's1';
  assert.throws(() => validateCoreResult(duplicatedSentences, speechInfo), /MODEL_SENTENCE_IDS_INVALID/);
  const duplicatedEmbeddings = coreResult();
  duplicatedEmbeddings.embeddedSentenceIds = ['s1', 's1'];
  assert.throws(() => validateCoreResult(duplicatedEmbeddings, speechInfo), /MODEL_EMBEDDINGS_INCOMPLETE/);
});

test('matrix checks actual OS, browser and runner label even when architecture matches', () => {
  for (const field of ['os', 'browser', 'runner']) {
    const cells = passingCells();
    cells[0].environment[field] = 'wrong';
    assert.equal(evaluateMatrix(cells).status, 'failed');
  }
});

test('matrix rejects stale or forged identity flags and framework failures', () => {
  const mismatchedExpected = passingCells();
  mismatchedExpected[0].expectedBuildId = 'wrong';
  assert.equal(evaluateMatrix(mismatchedExpected).status, 'failed');
  assert.equal(evaluateRaw(passingCells(), 'smoke', 'different-requested-build').status, 'failed');
  assert.equal(evaluateRaw(passingCells(), 'smoke').status, 'failed');
  for (const change of [
    cells => { cells[0].failureCode = 'EXPORT_FAILED'; },
    cells => { cells[0].frameworkErrors = [{ code: 'TEST_TIMEOUT' }]; },
    cells => { cells[0].tests[0].diagnostics.buildId = 'wrong'; },
    cells => { delete cells[0].tests[0].diagnostics; },
  ]) {
    const cells = passingCells();
    change(cells);
    assert.equal(evaluateMatrix(cells).status, 'failed');
  }
});

test('models matrix requires both distinct checks and per-check build identity', () => {
  assert.equal(evaluateMatrix(passingCells('models'), 'models').status, 'passed');
  const duplicateCheck = passingCells('models');
  duplicateCheck[0].tests[1].checkId = 'media-smoke';
  assert.equal(evaluateMatrix(duplicateCheck, 'models').status, 'failed');
  const missingModelIdentity = passingCells('models');
  delete missingModelIdentity[1].tests[1].diagnostics;
  assert.equal(evaluateMatrix(missingModelIdentity, 'models').status, 'failed');
});
