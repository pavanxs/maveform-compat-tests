import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, validateExpectedBuildId } from './target.mjs';
import { evaluateMatrix as evaluateRaw } from './matrix.mjs';
import { createPlan, workflowMatrix, PROFILE_IDS } from './profiles.mjs';
import { compareCaptionFrames } from './validate-media.mjs';
import { validateCoreResult, runCoreModelCheck } from './validate-models.mjs';
import { capabilitiesForReport, snapshotForReport, publicFailure, runtimeFailure, runtimeForReport } from './report-utils.mjs';
import { executableArchitectureFromBuffer, selectedBrowser, normalizeArchitecture, chromiumVersionArchitecture, testBudgetMs } from './runtime-environment.mjs';

function requestFor(suite = 'smoke', profileId = 'baseline') {
  return { profileId, suite, expectedBuildId: 'sha-012345', harnessCommit: 'a'.repeat(40), runId: '17', runAttempt: '1' };
}
const evaluateMatrix = (cells, suite = 'smoke', profileId = 'baseline') => evaluateRaw(cells, requestFor(suite, profileId));

function observedRuntime(cell) {
  const product = cell.release.product || (cell.os === 'linux' ? 'Ubuntu' : cell.os === 'darwin' ? 'macOS' : 'Windows Server 2025');
  const version = cell.os === 'linux' ? (cell.release.version || '24.04') :
    cell.os === 'darwin' ? (cell.release.version || '26') + '.0' :
    '10.0.' + (cell.release.build || '26100');
  const evidence = cell.os === 'linux' ? 'elf-' : cell.os === 'darwin' ? 'mach-o-' : 'pe-';
  return {
    os: { platform: cell.os, release: cell.os === 'linux' ? '6.8.0-azure' : cell.os === 'darwin' ? '25.0.0' : version, version, product },
    image: { os: 'controlled-image', version: '20261107.1' },
    arch: { host: cell.arch, node: cell.arch, browser: cell.arch, browserEvidence: evidence + cell.arch },
    browser: { name: cell.browser === 'webkit' ? 'webkit' : 'chromium', channel: cell.browser, version: '156.0.1' },
    node: { version: '24.10.0' },
  };
}
function passingCells(suite = 'smoke', profileId = 'baseline') {
  const request = requestFor(suite, profileId);
  return createPlan(profileId, suite).cells.map(cell => {
    const context = {
      cellId: cell.id, profileId, requestedSuite: suite, suite: cell.suite,
      harnessCommit: request.harnessCommit, expectedHarnessCommit: request.harnessCommit,
      runId: request.runId, runAttempt: request.runAttempt,
    };
    return {
      schemaVersion: 2, ...context, status: 'passed', buildId: request.expectedBuildId,
      expectedBuildId: request.expectedBuildId, identityVerified: true,
      requiredChecks: [...cell.checks], modelScope: cell.modelScope, modelScopeReason: cell.modelScopeReason,
      environment: { runner: cell.runner, ...observedRuntime(cell) },
      failureCode: null, frameworkErrors: [],
      tests: cell.checks.map(checkId => ({
        checkId, status: 'passed', failure: null,
        diagnostics: {
          buildId: request.expectedBuildId, identityVerified: true,
          reportContext: { ...context }, runtimeEnvironment: observedRuntime(cell),
          models: { attempted: checkId === 'core-models', completed: checkId === 'core-models' },
        },
      })),
    };
  });
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
  assert.equal(evaluateRaw(passingCells(), { ...requestFor(), expectedBuildId: 'different-requested-build' }).status, 'failed');
  assert.equal(evaluateRaw(passingCells(), { ...requestFor(), expectedBuildId: null }).status, 'failed');
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

test('cold model-load timeouts are distinguished without exposing raw errors', () => {
  const code = runtimeFailure("Couldn't reach the AI service in time. Please check your connection.", 'MODEL_RUN_FAILED');
  assert.equal(code, 'MODEL_LOAD_TIMEOUT');
  assert.equal(runtimeFailure('The AI tools took too long to get ready. Please check your connection and try again.', 'MODEL_RUN_FAILED'), 'MODEL_LOAD_TIMEOUT');
  assert.deepEqual(publicFailure(new Error(code), 'real-core-models'), { code: 'MODEL_LOAD_TIMEOUT', stage: 'real-core-models' });
});

test('failed model calls and invalid results stay attempted but unfinished', async () => {
  for (const call of [
    async () => { throw new Error('MODEL_LOAD_TIMEOUT'); },
    async () => ({ ...coreResult(), embeddedSentenceIds: ['s1'], embeddingCount: 1 }),
  ]) {
    const compat = {
      diagnostics: { models: { attempted: false, completed: false } },
      call,
      checkIdentity() {},
      async snapshot() { return { models: { phase: 'ready' } }; },
    };
    await assert.rejects(runCoreModelCheck(compat, speechInfo), /MODEL_LOAD_TIMEOUT|MODEL_EMBEDDINGS_INCOMPLETE/);
    assert.deepEqual(compat.diagnostics.models, { attempted: true, completed: false });
  }
});

test('the four OS profiles preserve all seven requested groups and exact runner labels', () => {
  const expected = {
    current: ['ubuntu-slim', 'ubuntu-24.04', 'windows-2025', 'ubuntu-24.04-arm', 'windows-11-arm', 'macos-26-intel', 'macos-26'],
    older: ['ubuntu-slim', 'ubuntu-22.04', 'windows-2022', 'ubuntu-22.04-arm', 'windows-11-arm', 'macos-15-intel', 'macos-15'],
    newer: ['ubuntu-slim', 'ubuntu-26.04', 'windows-2025-vs2026', 'ubuntu-26.04-arm', 'windows-11-vs2026-arm', 'macos-26-intel', 'xcode-27'],
    aliases: ['ubuntu-slim', 'ubuntu-latest', 'windows-latest', 'ubuntu-24.04-arm', 'windows-11-arm', 'macos-26-intel', 'macos-latest'],
  };
  for (const [profileId, runners] of Object.entries(expected)) {
    const plan = createPlan(profileId, 'models');
    assert.deepEqual(plan.cells.map(cell => cell.runner), runners);
    assert.equal(new Set(plan.cells.map(cell => cell.group)).size, 7);
    assert.equal(plan.expectedSmokeChecks, 7);
    assert.equal(plan.expectedModelChecks, 6);
    assert.deepEqual(plan.cells[0].checks, ['media-smoke']);
    assert.equal(plan.cells[0].modelScope, 'smoke-only');
    assert.equal(plan.cells[0].modelScopeReason, 'SLIM_15_MINUTE_LIMIT');
    assert.equal(plan.cells[0].jobTimeoutMinutes, 15);
    assert.ok(plan.cells.slice(1).every(cell => cell.jobTimeoutMinutes === 40));
    assert.deepEqual(workflowMatrix(plan).include.map(cell => [cell.id, cell.runner, cell.suite]),
      plan.cells.map(cell => [cell.id, cell.runner, cell.suite]));
  }
});

test('the browser baseline stays six cells while every profile verifies its declared checks', () => {
  const baseline = createPlan('baseline', 'models');
  assert.equal(baseline.expectedCells, 6);
  assert.equal(baseline.expectedModelChecks, 6);
  assert.deepEqual(baseline.cells.map(cell => cell.browser), ['chrome', 'webkit', 'chrome', 'webkit', 'chrome', 'msedge']);
  for (const profileId of PROFILE_IDS) {
    for (const suite of ['smoke', 'models']) {
      assert.equal(evaluateMatrix(passingCells(suite, profileId), suite, profileId).status, 'passed');
    }
  }
  assert.throws(() => createPlan('unlisted'), /PROFILE_INVALID/);
  assert.throws(() => createPlan('current', 'unlisted'), /SUITE_INVALID/);
});

test('unexpected cells and wrong profile or check declarations cannot pass', () => {
  for (const change of [
    cells => { cells.push({ ...cells[0], cellId: 'unexpected-cell' }); },
    cells => { cells[0].profileId = 'older'; },
    cells => { cells[0].requestedSuite = 'smoke'; },
    cells => { cells[0].suite = 'models'; },
    cells => { cells[0].requiredChecks.push('core-models'); },
    cells => { cells[1].tests.push({ ...cells[1].tests[0], checkId: 'unknown' }); },
    cells => { cells[1].tests = [null]; },
    cells => { cells[1].tests[1].diagnostics.models.completed = false; },
  ]) {
    const cells = passingCells('models', 'current');
    change(cells);
    assert.equal(evaluateMatrix(cells, 'models', 'current').status, 'failed');
  }
});

test('exact harness commit and workflow attempt are required for every test and cell', () => {
  for (const change of [
    cells => { cells.forEach(cell => { cell.harnessCommit = 'b'.repeat(40); cell.expectedHarnessCommit = 'b'.repeat(40); }); },
    cells => { cells.forEach(cell => { cell.runId = '999'; }); },
    cells => { cells.forEach(cell => { cell.runAttempt = '2'; }); },
    cells => { cells[0].tests[0].diagnostics.reportContext.harnessCommit = 'b'.repeat(40); },
    cells => { cells[0].tests[0].diagnostics.reportContext.runId = '999'; },
    cells => { delete cells[0].tests[0].diagnostics.reportContext; },
  ]) {
    const cells = passingCells();
    change(cells);
    assert.equal(evaluateMatrix(cells).status, 'failed');
  }
  const cells = passingCells();
  for (const key of ['harnessCommit', 'runId', 'runAttempt']) {
    assert.equal(evaluateRaw(cells, { ...requestFor(), [key]: null }).status, 'failed');
  }
  assert.equal(evaluateRaw(cells, requestFor(), 1).status, 'failed');
});

test('host, Node, and actual browser architectures must each match the requested native lane', () => {
  for (const field of ['host', 'node', 'browser']) {
    const cells = passingCells('smoke', 'current');
    cells[4].environment.arch[field] = 'x64';
    assert.equal(evaluateMatrix(cells, 'smoke', 'current').status, 'failed');
  }
  for (const arch of ['unknown', 'universal']) {
    const cells = passingCells();
    cells[0].environment.arch.browser = arch;
    assert.equal(evaluateMatrix(cells).status, 'failed');
  }
  const missingPerTest = passingCells();
  delete missingPerTest[0].tests[0].diagnostics.runtimeEnvironment;
  assert.equal(evaluateMatrix(missingPerTest).status, 'failed');
});

test('pinned OS release and Windows product are verified instead of trusting a runner label', () => {
  for (const [index, field, value] of [
    [1, 'version', '22.04'], [5, 'version', '15.0'], [2, 'product', 'Microsoft Windows 11 Enterprise'],
    [2, 'version', '10.0.20348'],
  ]) {
    const cells = passingCells('smoke', 'current');
    cells[index].environment.os[field] = value;
    assert.equal(evaluateMatrix(cells, 'smoke', 'current').status, 'failed');
  }
  const alias = passingCells('smoke', 'aliases');
  alias[1].environment.os.version = '26.04';
  alias[1].tests[0].diagnostics.runtimeEnvironment.os.version = '26.04';
  assert.equal(evaluateMatrix(alias, 'smoke', 'aliases').status, 'passed');
});

test('runtime reports keep useful versions while removing paths and arbitrary secret fields', () => {
  const value = runtimeForReport({
    os: { platform: 'win32', release: '10.0.26100', version: '10.0.26100', product: 'Windows Server 2025' },
    arch: { host: 'arm64', node: 'x64', browser: 'arm64', browserEvidence: 'pe-arm64' },
    browser: { name: 'chromium', channel: 'msedge', version: '157.0.1', executable: 'C:\\private\\app.exe' },
    image: { os: 'win11-arm64', version: 'https://private.example.com?token=secret' },
    source: 'private', token: 'secret',
  });
  assert.equal(value.arch.node, 'x64');
  assert.equal(value.os.product, 'Windows Server 2025');
  assert.equal(value.image.version, null);
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.equal(JSON.stringify(value).includes('secret'), false);
});

test('native executable headers distinguish x64, ARM64 and mixed Mach-O binaries', () => {
  for (const [machine, architecture, evidence] of [
    [0x8664, 'x64', 'pe-x64'], [0xaa64, 'arm64', 'pe-arm64'],
    [0xa641, 'arm64', 'pe-arm64ec'], [0xa64e, 'arm64', 'pe-arm64x'],
  ]) {
    const pe = Buffer.alloc(128);
    pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.write('PE\0\0', 64); pe.writeUInt16LE(machine, 68);
    assert.deepEqual(executableArchitectureFromBuffer(pe), { architecture, evidence });
  }
  for (const [machine, architecture] of [[62, 'x64'], [183, 'arm64']]) {
    const elf = Buffer.alloc(64);
    elf[0] = 0x7f; elf.write('ELF', 1); elf[5] = 1; elf.writeUInt16LE(machine, 18);
    assert.deepEqual(executableArchitectureFromBuffer(elf), { architecture, evidence: 'elf-' + architecture });
  }
  const armMach = Buffer.alloc(64);
  armMach.writeUInt32BE(0xcffaedfe, 0); armMach.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(executableArchitectureFromBuffer(armMach), { architecture: 'arm64', evidence: 'mach-o-arm64' });
  const universal = Buffer.alloc(64);
  universal.writeUInt32BE(0xcafebabe, 0); universal.writeUInt32BE(2, 4);
  universal.writeUInt32BE(0x01000007, 8); universal.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(executableArchitectureFromBuffer(universal), { architecture: 'universal', evidence: 'mach-o-universal' });
  assert.deepEqual(executableArchitectureFromBuffer(Buffer.alloc(8)), { architecture: 'unknown', evidence: 'unknown' });
});

test('Linux and Windows ARM choose supported native browsers and reject Chrome substitution', () => {
  assert.equal(selectedBrowser(null, { platform: 'linux', host: 'arm64' }), 'chromium');
  assert.equal(selectedBrowser(null, { platform: 'win32', host: 'arm64' }), 'msedge');
  assert.throws(() => selectedBrowser('chrome', { platform: 'win32', host: 'arm64' }), /PLATFORM_MISMATCH/);
  assert.throws(() => selectedBrowser('chrome', { platform: 'linux', host: 'arm64' }), /PLATFORM_MISMATCH/);
  assert.equal(normalizeArchitecture('AMD64'), 'x64');
  assert.equal(normalizeArchitecture('aarch64'), 'arm64');
});

test('Mac Chromium reports the running slice, including translated x64, without guessing from bitness', () => {
  for (const suffix of ['(x86_64)', '(x86_64 translated)']) {
    assert.deepEqual(chromiumVersionArchitecture('156.0.1 (Official Build) ' + suffix),
      { architecture: 'x64', evidence: 'chromium-version-x64' });
  }
  assert.deepEqual(chromiumVersionArchitecture('156.0.1 (Official Build) (arm64)'),
    { architecture: 'arm64', evidence: 'chromium-version-arm64' });
  assert.deepEqual(chromiumVersionArchitecture('156.0.1 (64-bit)'),
    { architecture: 'unknown', evidence: 'unknown' });
});

test('standard model test budgets allow the full app attempt and still leave reporter time', () => {
  const saved = process.env.COMPAT_TEST_BUDGET_MS;
  try {
    delete process.env.COMPAT_TEST_BUDGET_MS;
    assert.equal(testBudgetMs('models'), 900_000);
    assert.equal(testBudgetMs('smoke'), 240_000);
    const plan = createPlan('current', 'models');
    assert.equal(plan.cells[0].testBudgetMs, 240_000);
    for (const cell of plan.cells.slice(1)) {
      assert.equal(cell.testBudgetMs, 900_000);
      assert.equal(cell.testStepTimeoutMinutes, 16);
    }
    process.env.COMPAT_TEST_BUDGET_MS = '900000';
    assert.equal(testBudgetMs('models'), 900_000);
    process.env.COMPAT_TEST_BUDGET_MS = '900001';
    assert.throws(() => testBudgetMs('models'), /TEST_BUDGET_INVALID/);
  } finally {
    if (saved === undefined) delete process.env.COMPAT_TEST_BUDGET_MS;
    else process.env.COMPAT_TEST_BUDGET_MS = saved;
  }
});
