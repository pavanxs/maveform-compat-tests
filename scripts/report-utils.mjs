export const PUBLIC_ERROR_CODES = new Set([
  'TARGET_REQUIRED', 'TARGET_INVALID', 'TARGET_INSECURE',
  'BUILD_ID_REQUIRED', 'BUILD_ID_INVALID', 'BUILD_ID_MISSING', 'BUILD_ID_MISMATCH',
  'BUILD_ID_CHANGED_DURING_RUN', 'NAVIGATION_FAILED', 'PREVIEW_ROUTE_UNAVAILABLE',
  'COMPAT_CONTRACT_MISSING', 'COMPAT_METHOD_MISSING', 'CAPABILITY_PROBE_FAILED',
  'VIDEO_DECODER_UNAVAILABLE', 'VIDEO_ENCODER_UNAVAILABLE', 'H264_ENCODE_UNAVAILABLE',
  'FIXTURE_MISSING', 'FIXTURE_INVALID', 'SOURCE_LOAD_FAILED', 'SOURCE_LOAD_TIMEOUT',
  'SOURCE_METADATA_MISMATCH', 'SOURCE_BROWSER_DECODE_FAILED', 'SOURCE_BROWSER_FRAME_BLANK',
  'EXPORT_FAILED', 'DOWNLOAD_MISSING', 'DOWNLOAD_FAILED', 'EXPORT_METADATA_MISMATCH',
  'UNEXPECTED_MODEL_RUN', 'MEDIA_TOOL_FAILED', 'OUTPUT_VIDEO_MISSING', 'OUTPUT_AUDIO_MISSING',
  'OUTPUT_VIDEO_CODEC_MISMATCH', 'OUTPUT_AUDIO_CODEC_MISMATCH', 'OUTPUT_DIMENSIONS_MISMATCH',
  'OUTPUT_DURATION_MISMATCH', 'OUTPUT_FILE_TOO_SMALL', 'OUTPUT_FRAME_DECODE_FAILED',
  'OUTPUT_FRAMES_BLANK', 'OUTPUT_FRAMES_FROZEN', 'OUTPUT_AUDIO_TOO_SHORT',
  'OUTPUT_AUDIO_SILENT_OR_CLIPPED', 'OUTPUT_AUDIO_DURATION_MISMATCH', 'OUTPUT_AUDIO_TONE_MISMATCH',
  'CAPTIONS_NOT_VISIBLE_IN_EXPORT', 'MODEL_RUN_FAILED', 'MODEL_DOWNLOAD_FAILED', 'MODEL_LOAD_TIMEOUT',
  'MODEL_SPEECH_NOT_RECOGNIZED', 'MODEL_TIMESTAMPS_INVALID', 'MODEL_EMBEDDINGS_MISSING',
  'MODEL_CLIPS_MISSING', 'MODEL_RESULT_INVALID', 'MODEL_EMBEDDINGS_INCOMPLETE', 'MODEL_SENTENCE_IDS_INVALID', 'MODEL_OPTIONAL_LANE_MISREPORTED',
  'TEST_TIMEOUT', 'TEST_INTERRUPTED', 'UNCLASSIFIED_FAILURE', 'SETUP_FAILED',
  'EXPECTED_TESTS_NOT_PASSED', 'CELL_REPORT_MISSING', 'RUNNER_ARCHITECTURE_MISMATCH',
  'MEDIA_TOOLS_MISSING', 'SPEECH_FIXTURE_UNAVAILABLE', 'SPEECH_FIXTURE_INVALID',
  'PROFILE_INVALID', 'SUITE_INVALID', 'HARNESS_ID_REQUIRED', 'HARNESS_ID_MISMATCH', 'WORKFLOW_ID_INVALID',
  'REPORT_IDENTITY_MISMATCH', 'REPORT_SCHEMA_INVALID', 'BROWSER_IDENTITY_MISMATCH',
  'RUNNER_ENVIRONMENT_MISMATCH', 'RUNNER_OS_VERSION_MISMATCH', 'RUNNER_OS_PRODUCT_MISMATCH',
  'PLATFORM_UNSUPPORTED', 'PLATFORM_MISMATCH', 'BROWSER_INVALID', 'BROWSER_INSTALL_FAILED',
  'BROWSER_EXECUTABLE_MISSING', 'BROWSER_ARCHITECTURE_UNKNOWN', 'BROWSER_ARCHITECTURE_MISMATCH',
  'MEDIA_DEPENDENCY_UNSUPPORTED', 'SLIM_TIME_BUDGET_EXCEEDED', 'FRAMEWORK_ERROR',
  'MEDIA_ENCODER_UNAVAILABLE', 'TEST_BUDGET_INVALID', 'TEST_RUNNER_FAILED', 'MODEL_SCOPE_MISMATCH',
]);

export function publicFailure(error, stage = 'unknown') {
  const raw = String(error?.message || error || '');
  for (const code of PUBLIC_ERROR_CODES) {
    if (new RegExp('(?:^|[^A-Z0-9_])' + code + '(?:$|[^A-Z0-9_])').test(raw)) return { code, stage: safeLabel(stage) };
  }
  return { code: /timeout|timed out|TimeoutError/i.test(raw) ? 'TEST_TIMEOUT' : 'UNCLASSIFIED_FAILURE', stage: safeLabel(stage) };
}

export function runtimeFailure(error, fallback) {
  const raw = String(error?.message || error || '');
  if (fallback === 'MODEL_RUN_FAILED' && /couldn.t reach.*in time|ai tools took too long to get ready|load timeout|model.*timed out/i.test(raw)) return 'MODEL_LOAD_TIMEOUT';
  if (/VideoDecoder.*(not defined|unavailable|not supported)/i.test(raw)) return 'VIDEO_DECODER_UNAVAILABLE';
  if (/VideoEncoder.*(not defined|unavailable|not supported)/i.test(raw)) return 'VIDEO_ENCODER_UNAVAILABLE';
  if (/(avc|h264|h\.264).*(unsupported|not supported|unavailable)/i.test(raw)) return 'H264_ENCODE_UNAVAILABLE';
  if (/(fetch|download|network|HTTP).*(fail|error|403|404|500)/i.test(raw)) return 'MODEL_DOWNLOAD_FAILED';
  return PUBLIC_ERROR_CODES.has(fallback) ? fallback : 'UNCLASSIFIED_FAILURE';
}

export function safeLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : 'unknown';
}

export function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function safeBuildId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}

export function capabilitiesForReport(value = {}) {
  const booleans = [
    'secureContext', 'crossOriginIsolated', 'sharedArrayBuffer', 'webAssembly',
    'webgpu', 'videoDecoder', 'videoEncoder', 'audioDecoder', 'audioEncoder',
    'audioContext', 'offscreenCanvas', 'avcEncode',
  ];
  return {
    ...Object.fromEntries(booleans.map(key => [key, typeof value[key] === 'boolean' ? value[key] : null])),
    cores: numberOrNull(value.cores),
    // Never retain arbitrary probe text: it can contain private code paths.
    probeErrorCount: Array.isArray(value.probeErrors) ? value.probeErrors.length : 0,
    probeErrorCodes: Array.isArray(value.probeErrors)
      ? [...new Set(value.probeErrors.map(error => runtimeFailure(error, 'CAPABILITY_PROBE_FAILED')))] : [],
  };
}

export function snapshotForReport(value = {}) {
  const artifact = value.export?.artifact;
  return {
    version: value.version === 1 ? 1 : null,
    buildId: safeBuildId(value.buildId),
    mode: value.mode === 'deterministic-media' ? value.mode : 'unknown',
    sourceStatus: safeLabel(value.sourceStatus),
    source: value.source ? {
      bytes: numberOrNull(value.source.bytes), width: numberOrNull(value.source.width),
      height: numberOrNull(value.source.height), durationS: numberOrNull(value.source.durationS),
    } : null,
    sourceErrorCode: value.sourceError ? runtimeFailure(value.sourceError, 'SOURCE_LOAD_FAILED') : null,
    export: {
      phase: safeLabel(value.export?.phase), progress: numberOrNull(value.export?.progress),
      errorCode: value.export?.error ? runtimeFailure(value.export.error, 'EXPORT_FAILED') : null,
      artifact: artifact ? {
        bytes: numberOrNull(artifact.bytes), width: numberOrNull(artifact.width),
        height: numberOrNull(artifact.height), startS: numberOrNull(artifact.startS),
        endS: numberOrNull(artifact.endS), captions: artifact.captions === true,
        audioMode: safeLabel(artifact.audioMode), elapsedMs: numberOrNull(artifact.elapsedMs),
        buildId: safeBuildId(artifact.buildId),
      } : null,
    },
    models: {
      phase: safeLabel(value.models?.phase),
      transcriptionPhase: safeLabel(value.models?.transcriptionPhase),
      atlasPhase: safeLabel(value.models?.atlasPhase),
      wordCount: numberOrNull(value.models?.wordCount),
      sentenceCount: numberOrNull(value.models?.sentenceCount),
      embeddingCount: numberOrNull(value.models?.embeddingCount),
      errorCode: value.models?.error ? runtimeFailure(value.models.error, 'MODEL_RUN_FAILED') : null,
    },
  };
}

export function markdownCell(value) {
  return String(value ?? '—').replace(/[|\r\n]/g, ' ').slice(0, 180);
}

export function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function systemText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9 ._()+:-]{1,160}$/.test(value) ? value : null;
}
export function runtimeForReport(value = {}) {
  const arch = field => ['x64', 'arm64', 'ia32', 'universal', 'unknown'].includes(field) ? field : 'unknown';
  const browserChannels = ['chromium', 'chrome', 'msedge', 'webkit'];
  return {
    os: {
      platform: ['linux', 'darwin', 'win32'].includes(value.os?.platform) ? value.os.platform : null,
      release: systemText(value.os?.release), version: systemText(value.os?.version), product: systemText(value.os?.product),
    },
    image: { os: systemText(value.image?.os), version: systemText(value.image?.version) },
    arch: {
      host: arch(value.arch?.host), node: arch(value.arch?.node), browser: arch(value.arch?.browser),
      browserEvidence: systemText(value.arch?.browserEvidence),
    },
    browser: {
      name: ['chromium', 'webkit'].includes(value.browser?.name) ? value.browser.name : null,
      channel: browserChannels.includes(value.browser?.channel) ? value.browser.channel : null,
      version: systemText(value.browser?.version),
    },
    node: { version: systemText(value.node?.version) },
  };
}
