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
  'CAPTIONS_NOT_VISIBLE_IN_EXPORT', 'MODEL_RUN_FAILED', 'MODEL_DOWNLOAD_FAILED',
  'MODEL_SPEECH_NOT_RECOGNIZED', 'MODEL_TIMESTAMPS_INVALID', 'MODEL_EMBEDDINGS_MISSING',
  'MODEL_CLIPS_MISSING', 'MODEL_RESULT_INVALID', 'MODEL_EMBEDDINGS_INCOMPLETE', 'MODEL_SENTENCE_IDS_INVALID', 'MODEL_OPTIONAL_LANE_MISREPORTED',
  'TEST_TIMEOUT', 'TEST_INTERRUPTED', 'UNCLASSIFIED_FAILURE', 'SETUP_FAILED',
  'EXPECTED_TESTS_NOT_PASSED', 'CELL_REPORT_MISSING', 'RUNNER_ARCHITECTURE_MISMATCH',
  'MEDIA_TOOLS_MISSING', 'SPEECH_FIXTURE_UNAVAILABLE', 'SPEECH_FIXTURE_INVALID',
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
