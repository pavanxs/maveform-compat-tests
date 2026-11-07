import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { linuxRelease } from './runtime-environment.mjs';

export function mediaBinary(kind) {
  if (!['ffmpeg', 'ffprobe'].includes(kind)) throw new Error('MEDIA_TOOL_FAILED');
  const configured = process.env[kind === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (configured) return configured;
  if (process.platform === 'win32') {
    const root = process.env.ChocolateyInstall || path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey');
    const shim = path.join(root, 'bin', kind + '.exe');
    if (existsSync(shim)) return shim;
  }
  if (process.platform === 'darwin') {
    for (const root of ['/opt/homebrew/bin', '/usr/local/bin']) {
      const candidate = path.join(root, kind);
      if (existsSync(candidate)) return candidate;
    }
  }
  return kind;
}

export function runTool(command, args, { binary = false, timeout = 120_000, maxBuffer = 32 * 1024 * 1024, env = {} } = {}) {
  const result = spawnSync(command, args, {
    encoding: binary ? undefined : 'utf8', timeout, maxBuffer, windowsHide: true,
    env: { ...process.env, ...env, AV_LOG_FORCE_NOCOLOR: '1' },
  });
  if (result.error || result.status !== 0) {
    const error = new Error('MEDIA_TOOL_FAILED: ' + path.basename(command) + ' did not complete successfully.');
    error.code = result.error?.code || 'MEDIA_TOOL_FAILED';
    // Kept on the local error only; public reporters never publish raw tool output.
    error.localDetails = String(result.stderr || result.error?.message || '').slice(0, 4000);
    throw error;
  }
  return result.stdout;
}

export function mediaVersion(kind) {
  const line = runTool(mediaBinary(kind), ['-version']).split(/\r?\n/)[0];
  const match = /^ff(?:mpeg|probe) version ([A-Za-z0-9_.+:-]{1,100})(?:\s|$)/.exec(line);
  if (!match) throw new Error('MEDIA_TOOLS_MISSING');
  return kind + ' ' + match[1];
}

export function requireMediaEncoders() {
  const encoders = runTool(mediaBinary('ffmpeg'), ['-hide_banner', '-encoders']);
  if (!/^\s*V\S*\s+libx264\s/m.test(encoders) || !/^\s*A\S*\s+aac\s/m.test(encoders)) {
    throw new Error('MEDIA_ENCODER_UNAVAILABLE');
  }
}

export function requireSupportedMediaPlatform() {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) throw new Error('MEDIA_DEPENDENCY_UNSUPPORTED');
  if (process.platform !== 'linux') return;
  const release = linuxRelease();
  const supported = (release.ID === 'ubuntu' && ['22.04', '24.04', '26.04'].includes(release.VERSION_ID)) ||
    (release.ID === 'debian' && ['12', '13'].includes(release.VERSION_ID));
  if (!supported) throw new Error('MEDIA_DEPENDENCY_UNSUPPORTED');
}

export function speechAvailable() {
  try {
    if (process.platform === 'linux') return /eSpeak NG/i.test(runTool('espeak-ng', ['--version'], { timeout: 10_000 }));
    if (process.platform === 'darwin') return existsSync('/usr/bin/say');
    return process.platform === 'win32'; // The synthesis command checks installed Windows voices.
  } catch { return false; }
}

export function probeMedia(file) {
  return JSON.parse(runTool(mediaBinary('ffprobe'), [
    '-v', 'error', '-show_entries',
    'format=duration,size:stream=index,codec_type,codec_name,width,height,start_time,duration,nb_frames,r_frame_rate,channels,sample_rate',
    '-of', 'json', file,
  ]));
}
