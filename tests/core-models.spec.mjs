import { test, ensure } from './helpers.mjs';
import { validateCoreResult } from '../scripts/validate-models.mjs';

test('real speech and Atlas models process generated speech and find clips', async ({ compat }) => {
  await compat.open();
  const selected = await compat.upload('speech');
  ensure(selected.info.durationS >= 30, 'SPEECH_FIXTURE_INVALID');
  compat.stage('real-core-models');
  const result = await compat.call('runCoreModels', [], 'MODEL_RUN_FAILED');
  compat.checkIdentity(result.buildId);
  compat.diagnostics.models = validateCoreResult(result, selected.info);
  ensure((await compat.snapshot()).models?.phase === 'ready', 'MODEL_RUN_FAILED');
  compat.stage('complete');
});
