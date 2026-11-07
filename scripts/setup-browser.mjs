import { spawnSync } from 'node:child_process';
import { collectRuntimeEnvironment, inspectExecutableArchitecture, resolveBrowserExecutable, selectedBrowser } from './runtime-environment.mjs';

try {
  const runtime = await collectRuntimeEnvironment();
  const browser = selectedBrowser(undefined, { platform: runtime.os.platform, host: runtime.arch.host });
  if (runtime.arch.node !== runtime.arch.host) throw new Error('RUNNER_ARCHITECTURE_MISMATCH');
  const nativeWindowsArm = runtime.os.platform === 'win32' && runtime.arch.host === 'arm64';
  if (!nativeWindowsArm) {
    const args = ['node_modules/@playwright/test/cli.js', 'install'];
    if (runtime.os.platform === 'linux') args.push('--with-deps', '--no-shell');
    args.push(browser);
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true, timeout: 300_000 });
    if (result.error || result.status !== 0) throw new Error('BROWSER_INSTALL_FAILED');
  }
  const executable = resolveBrowserExecutable(browser);
  if (nativeWindowsArm) {
    // Playwright's Windows installers select x64; the ARM lane must reuse native Edge.
    const binary = inspectExecutableArchitecture(executable);
    if (binary.architecture === 'unknown') throw new Error('BROWSER_ARCHITECTURE_UNKNOWN');
    if (binary.architecture !== 'arm64') throw new Error('BROWSER_ARCHITECTURE_MISMATCH');
    console.log('Using installed native ARM64 Microsoft Edge (' + binary.evidence + ').');
  } else {
    console.log('Selected browser is ready: ' + browser + '.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
