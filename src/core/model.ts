// Model-input helpers shared by the VS Code (onnxruntime-node) and Chrome
// (onnxruntime-web) engines. Pure.

export const SAMPLE_RATE = 24000;
export const MAX_PHONEMES = 510; // the model's 512-token context minus the 2 pad tokens

/** Official tokenization (kokoro KModel.forward): each phoneme character in the
 *  vocab becomes its id, others are dropped, framed by the pad token 0. */
export function tokenize(phonemes: string, vocab: Record<string, number>): number[] {
  const ids: number[] = [];
  for (const ch of phonemes) {
    const id = vocab[ch];
    if (id !== undefined) ids.push(id);
  }
  return [0, ...ids.slice(0, MAX_PHONEMES), 0];
}

/** Voice-pack row for a sequence, as the official pipeline picks it:
 *  KPipeline uses voice[len(phonemes) - 1], and input_ids are the phonemes plus
 *  two pad tokens. (kokoro-js uses the next row up.) */
export function styleRow(numInputIds: number): number {
  return Math.min(Math.max(numInputIds - 3, 0), 509);
}

/** One voice's style vector for a sequence of `numInputIds` tokens, from its
 *  voice pack (510 rows of 256 floats). */
export function voiceStyle(pack: Float32Array, numInputIds: number): Float32Array {
  const row = styleRow(numInputIds) * 256;
  return pack.slice(row, row + 256);
}
