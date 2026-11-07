function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

export function validateCoreResult(result, fixture) {
  ensure(Array.isArray(result.words) && Array.isArray(result.sentences) && Array.isArray(result.clips), 'MODEL_RESULT_INVALID');
  const transcript = result.words.map(word => String(word.text)).join(' ').toLowerCase();
  const matchedExpectedWords = fixture.expectedWords.filter(word => new RegExp('\\b' + word + '\\b').test(transcript));
  ensure(result.words.length >= 20 && matchedExpectedWords.length >= 3, 'MODEL_SPEECH_NOT_RECOGNIZED');
  ensure(result.words.every(word =>
    Number.isFinite(word.start) && Number.isFinite(word.end) &&
    word.start >= 0 && word.end > word.start && word.end <= fixture.durationS + 1
  ), 'MODEL_TIMESTAMPS_INVALID');

  const sentenceIds = result.sentences.map(sentence => sentence.id);
  ensure(sentenceIds.length > 0 && sentenceIds.every(id => typeof id === 'string' && id.length > 0) &&
    new Set(sentenceIds).size === sentenceIds.length, 'MODEL_SENTENCE_IDS_INVALID');
  ensure(result.sentences.every(sentence =>
    Number.isFinite(sentence.startS) && Number.isFinite(sentence.endS) &&
    sentence.startS >= 0 && sentence.endS > sentence.startS && sentence.endS <= fixture.durationS + 1
  ), 'MODEL_TIMESTAMPS_INVALID');

  const embeddedIds = result.embeddedSentenceIds;
  ensure(Array.isArray(embeddedIds) &&
    new Set(embeddedIds).size === embeddedIds.length &&
    embeddedIds.length === sentenceIds.length &&
    Number.isInteger(result.embeddingCount) && result.embeddingCount === embeddedIds.length &&
    sentenceIds.every(id => embeddedIds.includes(id)), 'MODEL_EMBEDDINGS_INCOMPLETE');

  ensure(result.clips.length > 0, 'MODEL_CLIPS_MISSING');
  ensure(result.clips.every(clip =>
    clip.source === 'atlas' && Number.isFinite(clip.startS) && Number.isFinite(clip.endS) &&
    clip.startS >= 0 && clip.endS - clip.startS >= 14.8 && clip.endS <= fixture.durationS + 1 &&
    Number.isFinite(clip.durationS) && Math.abs(clip.durationS - (clip.endS - clip.startS)) < 0.2
  ), 'MODEL_RESULT_INVALID');
  for (const lane of ['faceDetection', 'sceneDetection', 'genesis']) {
    ensure(result.optionalLanes?.[lane] === 'not-run', 'MODEL_OPTIONAL_LANE_MISREPORTED');
  }
  return {
    attempted: true, completed: true, wordCount: result.words.length, sentenceCount: result.sentences.length,
    embeddingCount: result.embeddingCount, clipCount: result.clips.length, matchedExpectedWords,
    coverage: { sentencesUnique: true, embeddingIdsUnique: true, sentencesCovered: sentenceIds.length },
    atlasDevice: ['wasm', 'webgpu'].includes(result.atlasDevice) ? result.atlasDevice : null,
    preferredTranscriptionDevice: ['wasm', 'webgpu'].includes(result.preferredTranscriptionDevice) ? result.preferredTranscriptionDevice : null,
    optionalLanes: { faceDetection: 'not-run', sceneDetection: 'not-run', genesis: 'not-run' },
  };
}

export async function runCoreModelCheck(compat, fixture) {
  compat.diagnostics.models = { attempted: true, completed: false };
  compat.checkpoint?.();
  const result = await compat.call('runCoreModels', [], 'MODEL_RUN_FAILED');
  compat.checkIdentity(result.buildId);
  const verified = validateCoreResult(result, fixture);
  ensure((await compat.snapshot()).models?.phase === 'ready', 'MODEL_RUN_FAILED');
  compat.diagnostics.models = verified;
  return verified;
}
