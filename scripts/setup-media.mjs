import { appendFileSync } from 'node:fs';
import { mediaBinary, mediaVersion, runTool } from './media-tools.mjs';

function available() {
  try { mediaVersion('ffmpeg'); mediaVersion('ffprobe'); return true; } catch { return false; }
}

try {
  if (!available()) {
    if (!process.env.CI && process.env.COMPAT_ALLOW_TOOL_INSTALL !== '1') {
      throw new Error('MEDIA_TOOLS_MISSING: Install ffmpeg and ffprobe, or explicitly set COMPAT_ALLOW_TOOL_INSTALL=1.');
    }
    if (process.platform === 'darwin') {
      process.env.HOMEBREW_NO_AUTO_UPDATE = '1';
      runTool('brew', ['install', 'ffmpeg'], { timeout: 600_000 });
    } else if (process.platform === 'win32') {
      runTool('choco.exe', ['install', 'ffmpeg', '--yes', '--no-progress', '--limit-output'], { timeout: 600_000 });
    } else {
      throw new Error('MEDIA_TOOLS_MISSING: Install ffmpeg and ffprobe for this platform.');
    }
  }
  for (const kind of ['ffmpeg', 'ffprobe']) {
    console.log(mediaVersion(kind));
    if (process.env.GITHUB_ENV) {
      const variable = kind === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
      appendFileSync(process.env.GITHUB_ENV, variable + '=' + mediaBinary(kind) + '\n');
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
