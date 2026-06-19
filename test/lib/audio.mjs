// Audio helpers shared by the round-trip test.

/**
 * Linear-interpolation resampler. Kokoro emits 24kHz; Whisper expects 16kHz
 * mono Float32. Linear interpolation is plenty for ASR (we're verifying words,
 * not fidelity).
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const newLen = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = idx - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}
