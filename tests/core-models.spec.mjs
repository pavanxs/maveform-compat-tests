import { test, ensure } from './helpers.mjs';
import { runCoreModelCheck } from '../scripts/validate-models.mjs';

test('real speech and Atlas models process generated speech and find clips', async ({ compat }) => {
  await compat.open();
  const selected = await compat.upload('speech');
  ensure(selected.info.durationS >= 30, 'SPEECH_FIXTURE_INVALID');
  compat.stage('real-core-models');
  await runCoreModelCheck(compat, selected.info);
  compat.stage('complete');
});
