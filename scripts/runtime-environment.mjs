import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';

const require = createRequire(import.meta.url);
const safeText = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._()+#:-]{0,179}$/.test(value.trim()) ? value.trim() : null;

export function normalizeArchitecture(value) {
  const arch = String(value || '').toLowerCase();
  if (['x64', 'x86_64', 'amd64'].includes(arch)) return 'x64';
  if (['arm64', 'aarch64'].includes(arch)) return 'arm64';
  if (['x86', 'ia32', 'i386', 'i686'].includes(arch)) return 'ia32';
  return 'unknown';
}

function commandValue(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function linuxRelease() {
  try {
    return Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split(/\r?\n/).flatMap(line => {
      const match = /^(ID|VERSION_ID|PRETTY_NAME)=(.*)$/.exec(line);
      if (!match) return [];
      return [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]];
    }));
  } catch { return {}; }
}

export function hostArchitecture() {
  if (process.platform === 'darwin' && commandValue('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']) === '1') return 'arm64';
  // os.machine() uses the OS machine type, rather than the Node binary's arch.
  return normalizeArchitecture(os.machine());
}

export function selectedBrowser(value = process.env.COMPAT_BROWSER, { platform = process.platform, host = hostArchitecture() } = {}) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(host)) throw new Error('PLATFORM_UNSUPPORTED');
  const browser = value || (platform === 'linux' ? 'chromium' : platform === 'win32' && host === 'arm64' ? 'msedge' : 'chrome');
  if (!['chromium', 'chrome', 'msedge', 'webkit'].includes(browser)) throw new Error('BROWSER_INVALID');
  if ((platform === 'linux' && browser !== 'chromium') || (browser === 'chromium' && platform !== 'linux') ||
      (browser === 'webkit' && platform !== 'darwin') || (browser === 'msedge' && platform !== 'win32') ||
      (platform === 'win32' && host === 'arm64' && browser !== 'msedge')) throw new Error('PLATFORM_MISMATCH');
  return browser;
}

export function testBudgetMs(suite) {
  const configured = process.env.COMPAT_TEST_BUDGET_MS;
  const value = configured === undefined ? (suite === 'models' ? 900_000 : 240_000) : Number(configured);
  if (!Number.isInteger(value) || value < 30_000 || value > 900_000) throw new Error('TEST_BUDGET_INVALID');
  return value;
}

function cpuArchitecture(cpu) {
  return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : cpu === 7 ? 'ia32' : 'unknown';
}

export function executableArchitectureFromBuffer(bytes) {
  const unknown = { architecture: 'unknown', evidence: 'unknown' };
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) return unknown;
  if (bytes.toString('ascii', 0, 2) === 'MZ') {
    if (bytes.length < 64) return unknown;
    const offset = bytes.readUInt32LE(0x3c);
    if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\u0000\u0000') return unknown;
    const machine = bytes.readUInt16LE(offset + 4);
    const types = { 0x8664: ['x64', 'pe-x64'], 0xaa64: ['arm64', 'pe-arm64'], 0xa641: ['arm64', 'pe-arm64ec'], 0xa64e: ['arm64', 'pe-arm64x'], 0x14c: ['ia32', 'pe-ia32'] };
    const result = types[machine];
    return result ? { architecture: result[0], evidence: result[1] } : unknown;
  }
  if (bytes[0] === 0x7f && bytes.toString('ascii', 1, 4) === 'ELF') {
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes[5] === 2 ? bytes.readUInt16BE(18) : 0;
    const architecture = machine === 183 ? 'arm64' : machine === 62 ? 'x64' : machine === 3 ? 'ia32' : 'unknown';
    return { architecture, evidence: architecture === 'unknown' ? 'unknown' : 'elf-' + architecture };
  }
  const magic = bytes.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
    const littleEndian = magic === 0xcefaedfe || magic === 0xcffaedfe;
    const architecture = cpuArchitecture(littleEndian ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4));
    return { architecture, evidence: architecture === 'unknown' ? 'unknown' : 'mach-o-' + architecture };
  }
  if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
    const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
    const read = offset => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const count = read(4);
    const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
    if (count < 1 || count > 16 || 8 + count * stride > bytes.length) return unknown;
    const architectures = [...new Set(Array.from({ length: count }, (_, i) => cpuArchitecture(read(8 + i * stride))))];
    if (architectures.length === 1 && architectures[0] !== 'unknown') return { architecture: architectures[0], evidence: 'mach-o-' + architectures[0] };
    return { architecture: 'universal', evidence: 'mach-o-universal' };
  }
  return unknown;
}

export function inspectExecutableArchitecture(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const bytes = Buffer.alloc(64 * 1024);
    const size = readSync(descriptor, bytes, 0, bytes.length, 0);
    return executableArchitectureFromBuffer(bytes.subarray(0, size));
  } catch { return { architecture: 'unknown', evidence: 'unknown' }; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function resolveBrowserExecutable(channel) {
  // This registry API is covered by the exact Playwright version in package-lock.json.
  // It finds the same branded-channel executable that Playwright launches.
  try {
    const { registry: registryModule } = require('playwright-core/lib/coreBundle');
    const executable = registryModule.registry.findExecutable(channel)?.executablePath('javascript');
    if (!executable || !existsSync(executable)) throw new Error('missing');
    return executable;
  } catch { throw new Error('BROWSER_EXECUTABLE_MISSING'); }
}

function webkitMachO(wrapper) {
  if (process.platform !== 'darwin' || !wrapper.endsWith('.sh')) return wrapper;
  const root = path.dirname(wrapper);
  try {
    // Exact target and branch order in Playwright1.65's bundled pw_run.sh.
    // A development checkout can redirect this wrapper outside the installed bundle;
    // leave that case unproven instead of borrowing a sibling helper's architecture.
    const source = readFileSync(wrapper, 'utf8');
    if (!source.includes('PLAYWRIGHT="$DYLIB_PATH/Playwright.app/Contents/MacOS/Playwright"') ||
        existsSync(path.join(root, 'EXPECTED_BUILDS'))) return wrapper;
    const app = existsSync(path.join(root, 'Playwright.app')) ? path.join(root, 'Playwright.app')
      : path.join(root, 'WebKitBuild', 'Release', 'Playwright.app');
    const candidate = path.join(app, 'Contents', 'MacOS', 'Playwright');
    if (existsSync(candidate)) return candidate;
  } catch { /* Missing native executable remains an explicit unknown. */ }
  return wrapper;
}

export function chromiumVersionArchitecture(value) {
  // Chromium's VersionProcessorVariation uses the running Mac CPU type, including Rosetta.
  // https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/ui/webui/version/version_ui.cc
  const text = typeof value === 'string' ? value : '';
  if (/\(arm64\)/i.test(text)) return { architecture: 'arm64', evidence: 'chromium-version-arm64' };
  if (/\(x86_64(?: translated)?\)/i.test(text)) return { architecture: 'x64', evidence: 'chromium-version-x64' };
  return { architecture: 'unknown', evidence: 'unknown' };
}

async function macChromiumArchitecture(browser) {
  let context;
  try {
    context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto('chrome://version/', { waitUntil: 'domcontentloaded', timeout: 10_000 });
    // Do not read the command line or profile path elsewhere on this internal page.
    return chromiumVersionArchitecture(await page.locator('#version').textContent({ timeout: 5_000 }));
  } catch { return { architecture: 'unknown', evidence: 'unknown' }; }
  finally { if (context) await context.close().catch(() => {}); }
}

async function runningBrowserArchitecture(browser, channel) {
  let executable;
  if (browser.browserType().name() === 'chromium') {
    let session;
    try {
      session = await browser.newBrowserCDPSession();
      const command = await session.send('Browser.getBrowserCommandLine');
      executable = command.arguments?.[0]?.replace(/^"(.*)"$/, '$1');
    } catch { /* Fall back to the exact selected channel's executable. */ }
    finally { if (session) await session.detach().catch(() => {}); }
  }
  if (!executable) {
    try { executable = resolveBrowserExecutable(channel); } catch { /* A native runtime probe can still identify a universal Mac Chrome. */ }
  }
  const binary = executable ? inspectExecutableArchitecture(channel === 'webkit' ? webkitMachO(executable) : executable)
    : { architecture: 'unknown', evidence: 'unknown' };
  if (process.platform === 'darwin' && browser.browserType().name() === 'chromium' && ['universal', 'unknown'].includes(binary.architecture)) {
    const runtime = await macChromiumArchitecture(browser);
    if (runtime.architecture !== 'unknown') return runtime;
  }
  return binary;
}

export async function collectRuntimeEnvironment({ browser = null, browserName = null, channel = null } = {}) {
  let host = hostArchitecture();
  let version = null;
  let product = null;
  if (process.platform === 'linux') {
    const release = linuxRelease();
    version = safeText(release.VERSION_ID);
    product = safeText(release.PRETTY_NAME || release.ID);
  } else if (process.platform === 'darwin') {
    version = safeText(commandValue('/usr/bin/sw_vers', ['-productVersion']));
    product = safeText(commandValue('/usr/bin/sw_vers', ['-productName']));
  } else if (process.platform === 'win32') {
    const value = commandValue('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$compatOs = Get-CimInstance Win32_OperatingSystem; @{ version = $compatOs.Version; product = $compatOs.Caption; host = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } | ConvertTo-Json -Compress"]);
    try {
      const details = JSON.parse(value);
      version = safeText(details.version);
      product = safeText(details.product);
      if (normalizeArchitecture(details.host) !== 'unknown') host = normalizeArchitecture(details.host);
    } catch { /* Unobserved product/version must not pass a pinned-release check. */ }
  }
  const actualChannel = browser ? (channel || process.env.COMPAT_BROWSER || selectedBrowser()) : null;
  const binary = browser ? await runningBrowserArchitecture(browser, actualChannel) : { architecture: 'unknown', evidence: 'unknown' };
  return {
    os: { platform: process.platform, release: safeText(os.release()), version, product },
    image: { os: safeText(process.env.ImageOS), version: safeText(process.env.ImageVersion) },
    arch: { host, node: normalizeArchitecture(process.arch), browser: binary.architecture, browserEvidence: binary.evidence },
    node: { version: safeText(process.versions.node) },
    browser: { name: browser ? (browserName || browser.browserType().name()) : null, channel: actualChannel, version: browser ? safeText(browser.version()) : null },
  };
}
