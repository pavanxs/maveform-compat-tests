import { appendFileSync } from 'node:fs';
import { mediaBinary, mediaVersion, runTool, requireMediaEncoders, requireSupportedMediaPlatform, speechAvailable } from './media-tools.mjs';

function available() {
  try { mediaVersion('ffmpeg'); mediaVersion('ffprobe'); return true; } catch { return false; }
}

try {
  requireSupportedMediaPlatform();
  const needsMedia = !available();
  const needsSpeech = (process.env.COMPAT_SUITE === 'models' || process.argv.includes('--speech')) && !speechAvailable();
  if (needsMedia || needsSpeech) {
    if (!process.env.CI && process.env.COMPAT_ALLOW_TOOL_INSTALL !== '1') {
      throw new Error('MEDIA_TOOLS_MISSING: Install ffmpeg and ffprobe, or explicitly set COMPAT_ALLOW_TOOL_INSTALL=1.');
    }
    if (process.platform === 'darwin') {
      if (needsSpeech) throw new Error('SPEECH_FIXTURE_UNAVAILABLE');
      process.env.HOMEBREW_NO_AUTO_UPDATE = '1';
      runTool('brew', ['install', 'ffmpeg'], { timeout: 300_000 });
    } else if (process.platform === 'win32') {
      runTool('choco.exe', ['install', 'ffmpeg', '--yes', '--no-progress', '--limit-output'], { timeout: 300_000 });
    } else if (process.platform === 'linux') {
      const root = typeof process.getuid === 'function' && process.getuid() === 0;
      const command = root ? 'apt-get' : 'sudo';
      const prefix = root ? [] : ['-n', 'apt-get'];
      const options = { timeout: 180_000, env: { DEBIAN_FRONTEND: 'noninteractive' } };
      runTool(command, [...prefix, 'update'], options);
      runTool(command, [...prefix, 'install', '-y', '--no-install-recommends', ...(needsMedia ? ['ffmpeg'] : []), ...(needsSpeech ? ['espeak-ng'] : [])], options);
    } else {
      throw new Error('MEDIA_DEPENDENCY_UNSUPPORTED');
    }
  }
  requireMediaEncoders();
  if ((process.env.COMPAT_SUITE === 'models' || process.argv.includes('--speech')) && !speechAvailable()) throw new Error('SPEECH_FIXTURE_UNAVAILABLE');
  for (const kind of ['ffmpeg', 'ffprobe']) {
    console.log(mediaVersion(kind));
    if (process.env.GITHUB_ENV) {
      const variable = kind === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
      const executable = mediaBinary(kind);
      if (/[\r\n]/.test(executable)) throw new Error('MEDIA_TOOLS_MISSING');
      appendFileSync(process.env.GITHUB_ENV, variable + '=' + executable + '\n');
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
