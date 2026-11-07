import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mediaBinary, mediaVersion, runTool, probeMedia, requireMediaEncoders, requireSupportedMediaPlatform, speechAvailable } from './media-tools.mjs';

const root = path.resolve('.generated');
mkdirSync(root, { recursive: true });
const manifest = {
  schemaVersion: 1, syntheticOnly: true,
  generation: { ffmpeg: mediaVersion('ffmpeg'), ffprobe: mediaVersion('ffprobe'), platform: process.platform, arch: process.arch },
  smoke: null, speech: null,
};
const encoding = [
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264',
  '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
  '-preset', 'veryfast', '-crf', '18', '-bf', '0', '-threads', '1',
  '-fflags', '+bitexact', '-flags:v', '+bitexact',
  '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1',
  '-flags:a', '+bitexact', '-map_metadata', '-1', '-movflags', '+faststart',
];

function record(file, extra = {}) {
  const probe = probeMedia(file);
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  if (!video || !audio || video.width !== 320 || video.height !== 180) throw new Error('FIXTURE_INVALID');
  return {
    file: path.basename(file), bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    durationS: Number(probe.format.duration), width: video.width, height: video.height,
    videoCodec: video.codec_name, audioCodec: audio.codec_name, ...extra,
  };
}

try {
  requireSupportedMediaPlatform();
  requireMediaEncoders();
  const smoke = path.join(root, 'synthetic-smoke.mp4');
  runTool(mediaBinary('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    ...encoding, '-t', '3', smoke,
  ]);
  manifest.smoke = record(smoke, { fps: 24, toneHz: 440, modelsRun: false });

  if (process.argv.includes('--speech')) {
    const speechText = [
      'Welcome to the Maveform compatibility test. This recording contains only computer generated speech.',
      'First we check that the browser can read a local video. Next we find sentences and compare their meaning.',
      'Then we create short clips from the original recording. The picture contains moving coloured shapes, and no real people.',
      'Captions should remain inside the video. The sound should continue while the picture changes.',
      'Finally we export a playable file. This repeatable sample helps us find problems on different computers.',
    ].join(' ');
    const textPath = path.join(root, 'synthetic-speech.txt');
    writeFileSync(textPath, speechText + '\n');
    let audioPath;
    let synthesizer;
    if (!speechAvailable()) throw new Error('SPEECH_FIXTURE_UNAVAILABLE');
    if (process.platform === 'darwin') {
      audioPath = path.join(root, 'synthetic-speech.aiff');
      runTool('/usr/bin/say', ['-r', '145', '-f', textPath, '-o', audioPath]);
      synthesizer = 'macOS system speech';
    } else if (process.platform === 'win32') {
      audioPath = path.join(root, 'synthetic-speech.wav');
      runTool('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.resolve('scripts/generate-speech.ps1'),
        '-InputText', textPath, '-OutputAudio', audioPath,
      ]);
      synthesizer = 'Windows system speech';
    } else if (process.platform === 'linux') {
      audioPath = path.join(root, 'synthetic-speech.wav');
      runTool('espeak-ng', ['-v', 'en-us', '-s', '145', '-f', textPath, '-w', audioPath]);
      synthesizer = 'eSpeak NG English';
    } else {
      throw new Error('SPEECH_FIXTURE_UNAVAILABLE');
    }
    const spokenDuration = Number(probeMedia(audioPath).format.duration);
    if (!Number.isFinite(spokenDuration) || spokenDuration < 15 || spokenDuration > 70) {
      throw new Error('SPEECH_FIXTURE_INVALID: System speech did not produce a usable spoken sample.');
    }
    const duration = Math.max(32, Math.ceil(spokenDuration) + 1);
    const speech = path.join(root, 'synthetic-speech.mp4');
    runTool(mediaBinary('ffmpeg'), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=' + duration,
      '-i', audioPath, '-af', 'apad', ...encoding, '-t', String(duration), speech,
    ]);
    manifest.speech = record(speech, {
      fps: 12, synthesizer, spokenDurationS: spokenDuration,
      expectedWords: ['browser', 'video', 'clips', 'captions', 'recording', 'computers'],
      transcript: speechText,
    });
  }
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Generated synthetic smoke fixture: ' + manifest.smoke.bytes + ' bytes, 3 seconds.');
  if (manifest.speech) console.log('Generated synthetic speech fixture: ' + manifest.speech.durationS + ' seconds.');
} catch (error) {
  console.error(error.message);
  if (process.env.COMPAT_LOCAL_DEBUG === '1' && !process.env.CI && error.localDetails) console.error(error.localDetails);
  process.exitCode = 1;
}
