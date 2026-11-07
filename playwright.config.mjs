import { defineConfig, devices } from '@playwright/test';
import { validateTarget, validateExpectedBuildId } from './scripts/target.mjs';
import { selectedBrowser, testBudgetMs } from './scripts/runtime-environment.mjs';

const browser = selectedBrowser();
const suite = process.env.COMPAT_SUITE || 'smoke';
if (!['smoke', 'models'].includes(suite)) throw new Error('SUITE_INVALID: Select smoke or models.');
const budget = testBudgetMs(suite);
const localDebug = process.env.COMPAT_LOCAL_DEBUG === '1';
if (localDebug && process.env.CI) throw new Error('DEBUG_FORBIDDEN_IN_CI: Raw traces are local-only.');
const baseURL = validateTarget(process.env.MAVEFORM_BASE_URL);
validateExpectedBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID);

const project = browser === 'webkit'
  ? { name: 'webkit', use: { ...devices['Desktop Safari'], browserName: 'webkit' } }
  : browser === 'msedge'
    ? { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge', browserName: 'chromium' } }
    : { name: browser, use: { ...devices['Desktop Chrome'], channel: browser, browserName: 'chromium' } };

export default defineConfig({
  testDir: './tests',
  testMatch: suite === 'models' ? ['**/media.smoke.spec.mjs', '**/core-models.spec.mjs'] : '**/media.smoke.spec.mjs',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  globalTimeout: budget,
  timeout: Math.min(suite === 'models' ? 720_000 : 240_000, budget),
  expect: { timeout: 15_000 },
  outputDir: '.local-test-results',
  reporter: [
    ['./reporters/safe-reporter.mjs'],
    ...(localDebug ? [['html', { outputFolder: '.local-report', open: 'never' }]] : []),
  ],
  use: {
    baseURL,
    acceptDownloads: true,
    headless: process.env.COMPAT_HEADED !== '1',
    launchOptions: { timeout: 45_000 },
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
    trace: localDebug ? 'retain-on-failure' : 'off',
    screenshot: localDebug ? 'only-on-failure' : 'off',
    video: 'off',
  },
  projects: [project],
});
