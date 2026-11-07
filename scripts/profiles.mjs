export const PROFILE_IDS = ['current', 'older', 'newer', 'aliases', 'baseline'];
export const REQUIRED_CHECKS = { smoke: ['media-smoke'], models: ['media-smoke', 'core-models'] };

const GROUPS = [
  { group: 'linux-slim', os: 'linux', arch: 'x64', browser: 'chromium', modelSupport: false },
  { group: 'linux-x64', os: 'linux', arch: 'x64', browser: 'chromium', modelSupport: true },
  { group: 'windows-x64', os: 'win32', arch: 'x64', browser: 'chrome', modelSupport: true },
  { group: 'linux-arm64', os: 'linux', arch: 'arm64', browser: 'chromium', modelSupport: true },
  { group: 'windows-arm64', os: 'win32', arch: 'arm64', browser: 'msedge', modelSupport: true },
  { group: 'mac-intel', os: 'darwin', arch: 'x64', browser: 'chrome', modelSupport: true },
  { group: 'mac-arm64', os: 'darwin', arch: 'arm64', browser: 'chrome', modelSupport: true },
];
const RUNNERS = {
  current: ['ubuntu-slim', 'ubuntu-24.04', 'windows-2025', 'ubuntu-24.04-arm', 'windows-11-arm', 'macos-26-intel', 'macos-26'],
  older: ['ubuntu-slim', 'ubuntu-22.04', 'windows-2022', 'ubuntu-22.04-arm', 'windows-11-arm', 'macos-15-intel', 'macos-15'],
  newer: ['ubuntu-slim', 'ubuntu-26.04', 'windows-2025-vs2026', 'ubuntu-26.04-arm', 'windows-11-vs2026-arm', 'macos-26-intel', 'xcode-27'],
  aliases: ['ubuntu-slim', 'ubuntu-latest', 'windows-latest', 'ubuntu-24.04-arm', 'windows-11-arm', 'macos-26-intel', 'macos-latest'],
};
const BASELINE = [
  { group: 'mac-intel', runner: 'macos-15-intel', os: 'darwin', browser: 'chrome', arch: 'x64' },
  { group: 'mac-intel', runner: 'macos-15-intel', os: 'darwin', browser: 'webkit', arch: 'x64' },
  { group: 'mac-arm64', runner: 'macos-15', os: 'darwin', browser: 'chrome', arch: 'arm64' },
  { group: 'mac-arm64', runner: 'macos-15', os: 'darwin', browser: 'webkit', arch: 'arm64' },
  { group: 'windows', runner: 'windows-2025', os: 'win32', browser: 'chrome', arch: 'x64' },
  { group: 'windows', runner: 'windows-2025', os: 'win32', browser: 'msedge', arch: 'x64' },
];

function releaseConstraint(runner) {
  const ubuntu = /^ubuntu-(\d+\.\d+)(?:-arm)?$/.exec(runner);
  const mac = /^macos-(\d+)(?:-intel)?$/.exec(runner);
  if (ubuntu) return { mode: 'exact', version: ubuntu[1], product: 'Ubuntu' };
  if (mac) return { mode: 'major', version: mac[1], product: 'macOS' };
  if (runner.startsWith('windows-2022')) return { mode: 'product', product: 'Windows Server 2022', build: '20348' };
  if (runner.startsWith('windows-2025')) return { mode: 'product', product: 'Windows Server 2025', build: '26100' };
  if (runner.startsWith('windows-11')) return { mode: 'product', product: 'Windows 11' };
  // Aliases, ubuntu-slim, and Xcode-selected images report the actual OS instead of guessing it.
  return { mode: 'observed' };
}

export function createPlan(profileId = 'current', suite = 'smoke') {
  if (!PROFILE_IDS.includes(profileId)) throw new Error('PROFILE_INVALID');
  if (!Object.hasOwn(REQUIRED_CHECKS, suite)) throw new Error('SUITE_INVALID');
  const source = profileId === 'baseline'
    ? BASELINE.map(cell => ({ ...cell, modelSupport: true }))
    : GROUPS.map((group, i) => ({ ...group, runner: RUNNERS[profileId][i] }));
  const cells = source.map(cell => {
    const effectiveSuite = suite === 'models' && cell.modelSupport ? 'models' : 'smoke';
    return {
      ...cell, id: cell.group + '-' + cell.browser, profileId, requestedSuite: suite, suite: effectiveSuite,
      checks: [...REQUIRED_CHECKS[effectiveSuite]], release: releaseConstraint(cell.runner),
      modelScope: cell.modelSupport ? (suite === 'models' ? 'required' : 'not-requested') : 'smoke-only',
      modelScopeReason: cell.modelSupport ? null : 'SLIM_15_MINUTE_LIMIT',
      jobTimeoutMinutes: cell.runner === 'ubuntu-slim' ? 15 : 40,
      testBudgetMs: effectiveSuite === 'models' ? 900_000 : 240_000,
      testStepTimeoutMinutes: effectiveSuite === 'models' ? 16 : 5,
    };
  });
  return {
    schemaVersion: 2, profileId, requestedSuite: suite, cells,
    expectedCells: cells.length,
    expectedSmokeChecks: cells.length,
    expectedModelChecks: cells.filter(cell => cell.checks.includes('core-models')).length,
  };
}

export function workflowMatrix(plan) {
  return { include: plan.cells.map(cell => ({
    id: cell.id, group: cell.group, runner: cell.runner, os: cell.os, arch: cell.arch,
    browser: cell.browser, profileId: cell.profileId, suite: cell.suite,
    requestedSuite: cell.requestedSuite, modelScope: cell.modelScope,
    jobTimeoutMinutes: cell.jobTimeoutMinutes, testBudgetMs: cell.testBudgetMs,
    testStepTimeoutMinutes: cell.testStepTimeoutMinutes, slim: cell.runner === 'ubuntu-slim',
  })) };
}
