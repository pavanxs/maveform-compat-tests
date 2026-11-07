import { statSync } from 'node:fs';
import { mediaBinary, runTool, probeMedia } from './media-tools.mjs';

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function frameAt(file, atS) {
  const bytes = runTool(mediaBinary('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-ss', String(atS), '-i', file,
    '-frames:v', '1', '-vf', 'scale=135:240', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { binary: true });
  requireCondition(bytes.length === 135 * 240 * 3, 'OUTPUT_FRAME_DECODE_FAILED');
  return bytes;
}

function meanDelta(a, b, start = 0) {
  let total = 0;
  let largeChanges = 0;
  for (let i = start; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    total += delta;
    if (delta > 32) largeChanges++;
  }
  return { meanAbsoluteDelta: total / (a.length - start), changedChannels: largeChanges };
}

function audioMetrics(file) {
  const data = runTool(mediaBinary('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
  ], { binary: true });
  const count = data.length / 2;
  requireCondition(Number.isInteger(count) && count > 16000, 'OUTPUT_AUDIO_TOO_SHORT');
  let sum = 0;
  let crossings = 0;
  const start = Math.min(3200, Math.floor(count / 5));
  const end = count - start;
  let previous = 0;
  for (let i = start; i < end; i++) {
    const sample = data.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
    if ((sample >= 0) !== (previous >= 0)) crossings++;
    previous = sample;
  }
  return {
    rms: Math.sqrt(sum / (end - start)),
    estimatedToneHz: crossings * 16000 / (2 * (end - start)),
    decodedDurationS: count / 16000,
  };
}

export function validateExport(file, { expectedDurationS = 2, toneHz = 440 } = {}) {
  const probe = probeMedia(file);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  requireCondition(video, 'OUTPUT_VIDEO_MISSING');
  requireCondition(audio, 'OUTPUT_AUDIO_MISSING');
  requireCondition(video.codec_name === 'h264', 'OUTPUT_VIDEO_CODEC_MISMATCH');
  requireCondition(audio.codec_name === 'aac', 'OUTPUT_AUDIO_CODEC_MISMATCH');
  requireCondition(video.width === 540 && video.height === 960, 'OUTPUT_DIMENSIONS_MISMATCH');
  const durationS = Number(probe.format?.duration);
  requireCondition(Number.isFinite(durationS) && Math.abs(durationS - expectedDurationS) <= 0.2, 'OUTPUT_DURATION_MISMATCH');
  requireCondition(statSync(file).size > 4000, 'OUTPUT_FILE_TOO_SMALL');

  // Decode every encoded video/audio packet independently of the app/browser.
  runTool(mediaBinary('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-xerror', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
  ]);
  const first = frameAt(file, 0.35);
  const second = frameAt(file, 1.25);
  const mean = first.reduce((sum, value) => sum + value, 0) / first.length;
  const brightFraction = first.reduce((sum, value) => sum + (value > 40 ? 1 : 0), 0) / first.length;
  const motion = meanDelta(first, second);
  requireCondition(mean > 5 && brightFraction > 0.05, 'OUTPUT_FRAMES_BLANK');
  requireCondition(motion.meanAbsoluteDelta > 0.5, 'OUTPUT_FRAMES_FROZEN');

  const sound = audioMetrics(file);
  requireCondition(sound.rms > 0.005 && sound.rms < 0.9, 'OUTPUT_AUDIO_SILENT_OR_CLIPPED');
  requireCondition(Math.abs(sound.decodedDurationS - expectedDurationS) <= 0.25, 'OUTPUT_AUDIO_DURATION_MISMATCH');
  if (toneHz !== null) requireCondition(Math.abs(sound.estimatedToneHz - toneHz) < 30, 'OUTPUT_AUDIO_TONE_MISMATCH');

  return {
    bytes: statSync(file).size, width: video.width, height: video.height,
    durationS, videoCodec: video.codec_name, audioCodec: audio.codec_name,
    fullDecode: true, frameMean: mean, brightFraction,
    frameMotion: motion.meanAbsoluteDelta, ...sound,
  };
}

export function compareCaptionFrames(before, after) {
  requireCondition(before.length === 135 * 240 * 3 && after.length === before.length, 'OUTPUT_FRAME_DECODE_FAILED');
  // HORMOZI is centered at y=.78h. Compare its band with an equal-height control band.
  // The production no-face background is blurred moving video, not black bars.
  function regionDelta(firstRow, lastRow) {
    let sum = 0;
    let brightCaptionPixels = 0;
    const pixels = 135 * (lastRow - firstRow);
    for (let y = firstRow; y < lastRow; y++) {
      for (let x = 0; x < 135; x++) {
        const i = (y * 135 + x) * 3;
        const difference = (Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2])) / 3;
        sum += difference;
        const wasBright = (before[i] + before[i + 1] + before[i + 2]) / 3;
        const nowBright = (after[i] + after[i + 1] + after[i + 2]) / 3;
        const white = Math.min(after[i], after[i + 1], after[i + 2]) > 170;
        const gold = after[i] > 170 && after[i + 1] > 115 && after[i + 2] < 135;
        if ((white || gold) && difference > 45 && nowBright - wasBright > 45) brightCaptionPixels++;
      }
    }
    return { delta: sum / pixels, brightCaptionPixels, pixels };
  }
  const caption = regionDelta(163, 215);
  const background = regionDelta(23, 75);
  requireCondition(
    caption.delta > Math.max(0.7, background.delta * 3 + 0.25) &&
    caption.brightCaptionPixels > 12 && caption.brightCaptionPixels / caption.pixels < 0.4,
    'CAPTIONS_NOT_VISIBLE_IN_EXPORT',
  );
  return {
    captionDelta: caption.delta, controlDelta: background.delta,
    newCaptionColorPixels: caption.brightCaptionPixels,
    captionPixelFraction: caption.brightCaptionPixels / caption.pixels,
  };
}

export function compareCaptions(withoutCaptions, withCaptions) {
  const samples = [0.65, 1.65].map(atS => ({
    atS, ...compareCaptionFrames(frameAt(withoutCaptions, atS), frameAt(withCaptions, atS)),
  }));
  return { independentlyCompared: true, captionBandY: [650, 860], controlBandY: [90, 300], samples };
}
