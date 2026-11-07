import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAudioAlignment, validateStreamAlignment } from './audio-alignment.mjs';

function signal({ sampleRate = 16000, delayS = 0, speed = 1, pitch = 1, silent = false } = {}) {
  const samples = new Float32Array(Math.ceil(sampleRate * 2.05));
  for (let i = 0; i < samples.length; i++) {
    const sourceTime = 0.5 + i / sampleRate * speed - delayS;
    const frequency = sourceTime >= 1 && sourceTime < 2 ? 880 : 440;
    const value = silent ? 0 : 0.12 * Math.sin(2 * Math.PI * frequency * pitch * sourceTime);
    samples[i] = Math.round(value * 32768) / 32768;
  }
  return samples;
}

test('audio timing accepts correctly trimmed quantized samples at two sample rates', () => {
  for (const sampleRate of [16000, 48000]) {
    const result = validateAudioAlignment(signal({ sampleRate }), sampleRate);
    assert.equal(result.transitions.length, 2);
    assert.ok(result.maxAbsoluteErrorMs < 2);
  }
});

test('audio timing rejects one AAC frame of delayed encoder priming', () => {
  assert.throws(() => validateAudioAlignment(signal({ delayS: 1024 / 48000 })), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
});

test('audio timing rejects audio advanced by one AAC frame', () => {
  assert.throws(() => validateAudioAlignment(signal({ delayS: -1024 / 48000 })), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
});

test('audio timing detects drift even when the first transition is near its expected time', () => {
  assert.throws(() => validateAudioAlignment(signal({ speed: 1.02 })), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
});

test('audio timing permits a small timing shift inside the stated tolerance', () => {
  const result = validateAudioAlignment(signal({ delayS: 0.003 }));
  assert.ok(result.maxAbsoluteErrorMs > 2 && result.maxAbsoluteErrorMs < 5);
});

test('audio timing rejects incorrect tones and silence', () => {
  assert.throws(() => validateAudioAlignment(signal({ pitch: 1.1 })), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
  assert.throws(() => validateAudioAlignment(signal({ silent: true })), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
});

test('presented stream times must agree near zero even when the PCM has correct tones', () => {
  assert.equal(validateStreamAlignment('0.000000', '0.000000').offsetMs, 0);
  assert.equal(validateStreamAlignment('0.005', 0).offsetMs, 5);
  assert.throws(() => validateStreamAlignment(0.021333, 0), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
  assert.throws(() => validateStreamAlignment(0, 0.021333), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
  assert.throws(() => validateStreamAlignment(0.4, 0.4), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
});

test('missing stream timestamps are never interpreted as zero', () => {
  for (const missing of [undefined, null, '', ' ', 'N/A', NaN, Infinity]) {
    assert.throws(() => validateStreamAlignment(missing, 0), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
    assert.throws(() => validateStreamAlignment(0, missing), /OUTPUT_AUDIO_ALIGNMENT_MISMATCH/);
  }
});
