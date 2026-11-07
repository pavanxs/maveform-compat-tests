import { spawnSync } from 'node:child_process';

const suite = process.argv[2] || 'smoke';
if (!['smoke', 'models'].includes(suite)) throw new Error('SUITE_INVALID');
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(3)], {
  stdio: 'inherit', env: { ...process.env, COMPAT_SUITE: suite }, windowsHide: true,
});
if (result.error) console.error('TEST_RUNNER_FAILED: ' + result.error.code);
process.exitCode = result.status ?? 1;
