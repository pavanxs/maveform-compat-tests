import { spawnSync } from 'node:child_process';
import { testBudgetMs } from './runtime-environment.mjs';

const suite = process.argv[2] || 'smoke';
if (!['smoke', 'models'].includes(suite)) throw new Error('SUITE_INVALID');
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(3)], {
  stdio: 'inherit', env: { ...process.env, COMPAT_SUITE: suite }, windowsHide: true,
  timeout: testBudgetMs(suite) + 15_000,
});
if (result.error) console.error(result.error.code === 'ETIMEDOUT' ? 'TEST_TIMEOUT' : 'TEST_RUNNER_FAILED');
process.exitCode = result.status ?? 1;
