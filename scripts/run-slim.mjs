import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publicFailure } from './report-utils.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64' || process.env.COMPAT_RUNNER_LABEL !== 'ubuntu-slim') throw new Error('PLATFORM_MISMATCH');
if (process.env.COMPAT_SUITE !== 'smoke') throw new Error('SUITE_INVALID');
const directory = path.resolve('reports/internal');
mkdirSync(directory, { recursive: true });
const started = Date.now();
// Ten minutes for work, inside an eleven-minute step and a fifteen-minute job.
// Checkout, Node setup, the fallback report, and artifact upload have their own reserve.
const workBudgetMs = 600_000;
const stages = [
  ['target', process.execPath, ['scripts/target.mjs'], 15_000],
  ['dependencies', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 180_000],
  ['media-tools', process.execPath, ['scripts/setup-media.mjs'], 180_000],
  ['browser-install', process.execPath, ['scripts/setup-browser.mjs'], 240_000],
  ['fixtures', process.execPath, ['scripts/generate-fixtures.mjs'], 90_000],
  ['tests', process.execPath, ['scripts/run-tests.mjs', 'smoke'], 270_000],
];
function save(value) {
  writeFileSync(path.join(directory, 'slim-stage.json'), JSON.stringify({ ...value, elapsedMs: Date.now() - started }, null, 2) + '\n');
}
for (const [stage, command, args, limit] of stages) {
  const remaining = workBudgetMs - (Date.now() - started);
  if (remaining < 45_000) {
    save({ stage, status: 'failed', code: 'SLIM_TIME_BUDGET_EXCEEDED' });
    console.error('SLIM_TIME_BUDGET_EXCEEDED at ' + stage);
    process.exitCode = 1;
    break;
  }
  save({ stage, status: 'running', code: null });
  const testBudget = Math.min(240_000, remaining - 30_000);
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: Math.min(limit, remaining),
    env: { ...process.env, COMPAT_TEST_BUDGET_MS: String(testBudget) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Detailed setup output stays local and is excluded from uploaded artifacts.
  writeFileSync(path.join(directory, 'slim-' + stage + '.stdout.log'), result.stdout || '');
  writeFileSync(path.join(directory, 'slim-' + stage + '.stderr.log'), result.stderr || '');
  if (result.status !== 0 || result.error) {
    const parsed = publicFailure(result.stderr || result.stdout || '', stage);
    const code = result.error?.code === 'ETIMEDOUT' ? 'SLIM_TIME_BUDGET_EXCEEDED' :
      parsed.code === 'UNCLASSIFIED_FAILURE' ? 'SETUP_FAILED' : parsed.code;
    const npmCode = /npm error code (E[A-Z0-9_]+)/.exec(result.stderr || '')?.[1] || null;
    save({ stage, status: 'failed', code, exitCode: result.status, signal: result.signal || null, dependencyCode: npmCode });
    console.error(code + ' at ' + stage + (npmCode ? ' [' + npmCode + ']' : ''));
    process.exitCode = 1;
    break;
  }
  save({ stage, status: 'passed', code: null, exitCode: 0 });
  console.log('Completed slim stage: ' + stage);
}
