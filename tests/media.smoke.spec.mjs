import { test, ensure } from './helpers.mjs';
import { validateExport, compareCaptions } from '../scripts/validate-media.mjs';

test('synthetic video decodes and exports with real audio and rendered captions', async ({ compat }) => {
  await compat.open();
  compat.requireExportCapabilities();
  await compat.upload('smoke');
  const initial = await compat.snapshot();
  ensure(initial.mode === 'deterministic-media' && initial.models?.phase === 'not-run', 'UNEXPECTED_MODEL_RUN');

  const plain = await compat.export(false);
  compat.stage('external-validation-captions-off');
  const plainMetrics = validateExport(plain.file, { toneHz: null, verifyAudioAlignment: true });
  compat.diagnostics.exports.push({ captions: false, artifact: plain.artifact, inspected: plainMetrics });

  const captioned = await compat.export(true);
  compat.stage('external-validation-captions-on');
  const captionMetrics = validateExport(captioned.file, { toneHz: null, verifyAudioAlignment: true });
  compat.diagnostics.exports.push({ captions: true, artifact: captioned.artifact, inspected: captionMetrics });

  compat.stage('caption-pixel-comparison');
  compat.diagnostics.captions = compareCaptions(plain.file, captioned.file);
  ensure((await compat.snapshot()).models?.phase === 'not-run', 'UNEXPECTED_MODEL_RUN');
  compat.stage('complete');
});
