import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const files = ['playwright.config.mjs'];
for (const folder of ['scripts', 'tests', 'reporters']) {
  for (const entry of readdirSync(folder)) if (entry.endsWith('.mjs')) files.push(path.join(folder, entry));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
const tests = spawnSync(process.execPath, ['--test', 'scripts/harness.test.mjs'], { stdio: 'inherit', windowsHide: true });
process.exitCode = tests.status ?? 1;
