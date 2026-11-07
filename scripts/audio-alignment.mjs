export const SMOKE_AUDIO_PATTERN = Object.freeze({
  sourceTransitionsS: Object.freeze([1, 2]),
  frequenciesHz: Object.freeze([440, 880, 440]),
  trimStartS: 0.5,
  maxErrorMs: 10,
});

function requireAlignment(condition) {
  if (!condition) throw new Error('OUTPUT_AUDIO_ALIGNMENT_MISMATCH');
}

function kernel(frequencyHz, count, sampleRate) {
  const real = new Float64Array(count);
  const imaginary = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (count - 1));
    const phase = 2 * Math.PI * frequencyHz * i / sampleRate;
    real[i] = weight * Math.cos(phase);
    imaginary[i] = weight * Math.sin(phase);
  }
  return { real, imaginary };
}

function powerAt(samples, start, basis) {
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < basis.real.length; i++) {
    real += samples[start + i] * basis.real[i];
    imaginary += samples[start + i] * basis.imaginary[i];
  }
  return real * real + imaginary * imaginary;
}

function transitionAt(samples, sampleRate, expectedS, fromHz, toHz) {
  // Centered short windows locate the tone change, independently of MP4 edit-list timestamps.
  const count = Math.round(sampleRate * 0.016 / 2) * 2;
  const half = count / 2;
  const from = kernel(fromHz, count, sampleRate);
  const to = kernel(toHz, count, sampleRate);
  const scoreAt = center => {
    const start = center - half;
    if (start < 0 || start + count > samples.length) return null;
    const before = powerAt(samples, start, from);
    const after = powerAt(samples, start, to);
    return before + after > 1e-8 ? (after - before) / (before + after) : null;
  };
  const hop = Math.max(1, Math.round(sampleRate * 0.001));
  const first = Math.round((expectedS - 0.12) * sampleRate);
  const last = Math.round((expectedS + 0.12) * sampleRate);
  const candidates = [];
  let previous = null;
  for (let center = first; center <= last; center += hop) {
    const score = scoreAt(center);
    if (score !== null && previous && previous.score <= 0 && score > 0) {
      const fraction = -previous.score / (score - previous.score);
      const crossing = previous.center + fraction * (center - previous.center);
      const before = scoreAt(Math.round(crossing - sampleRate * 0.03));
      const after = scoreAt(Math.round(crossing + sampleRate * 0.03));
      if (before !== null && before < -0.7 && after !== null && after > 0.7) {
        candidates.push(crossing / sampleRate);
      }
    }
    previous = score === null ? null : { center, score };
  }
  requireAlignment(candidates.length > 0);
  return candidates.reduce((best, value) => Math.abs(value - expectedS) < Math.abs(best - expectedS) ? value : best);
}

function plateauTone(samples, sampleRate, centerS) {
  const start = Math.round((centerS - 0.05) * sampleRate);
  const end = Math.round((centerS + 0.05) * sampleRate);
  let crossings = 0;
  let previous = samples[start];
  for (let i = start + 1; i < end; i++) {
    const current = samples[i];
    if ((current >= 0) !== (previous >= 0)) crossings++;
    previous = current;
  }
  return crossings * sampleRate / (2 * (end - start - 1));
}

export function validateStreamAlignment(audioStart, videoStart) {
  const parse = value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  const audioStartS = parse(audioStart);
  const videoStartS = parse(videoStart);
  const { maxErrorMs } = SMOKE_AUDIO_PATTERN;
  requireAlignment(Number.isFinite(audioStartS) && Number.isFinite(videoStartS));
  const offsetMs = (audioStartS - videoStartS) * 1000;
  requireAlignment(
    Math.abs(audioStartS * 1000) <= maxErrorMs &&
    Math.abs(videoStartS * 1000) <= maxErrorMs &&
    Math.abs(offsetMs) <= maxErrorMs,
  );
  return { audioStartS, videoStartS, offsetMs };
}

export function validateAudioAlignment(samples, sampleRate = 16000) {
  requireAlignment(Number.isFinite(sampleRate) && sampleRate >= 8000 && samples.length >= sampleRate * 1.8);
  const { frequenciesHz, sourceTransitionsS, trimStartS, maxErrorMs } = SMOKE_AUDIO_PATTERN;
  const transitions = sourceTransitionsS.map((sourceS, i) => {
    const expectedS = sourceS - trimStartS;
    const observedS = transitionAt(samples, sampleRate, expectedS, frequenciesHz[i], frequenciesHz[i + 1]);
    const errorMs = (observedS - expectedS) * 1000;
    requireAlignment(Math.abs(errorMs) <= maxErrorMs);
    return { expectedS, observedS, errorMs };
  });
  const plateauTones = [0.25, 1, 1.75].map((atS, i) => {
    const expectedHz = frequenciesHz[i];
    const observedHz = plateauTone(samples, sampleRate, atS);
    requireAlignment(Math.abs(observedHz - expectedHz) < 20);
    return { atS, expectedHz, observedHz };
  });
  return {
    maxAllowedErrorMs: maxErrorMs,
    maxAbsoluteErrorMs: Math.max(...transitions.map(item => Math.abs(item.errorMs))),
    transitions,
    plateauTones,
  };
}
