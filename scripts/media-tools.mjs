import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function mediaBinary(kind) {
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

export function runTool(command, args, { binary = false, timeout = 120_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, {
    encoding: binary ? undefined : 'utf8', timeout, maxBuffer, windowsHide: true,
    env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' },
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
  return runTool(mediaBinary(kind), ['-version']).split(/\r?\n/)[0].slice(0, 180);
}

export function probeMedia(file) {
  return JSON.parse(runTool(mediaBinary('ffprobe'), [
    '-v', 'error', '-show_entries',
    'format=duration,size:stream=index,codec_type,codec_name,width,height,duration,nb_frames,r_frame_rate,channels,sample_rate',
    '-of', 'json', file,
  ]));
}
