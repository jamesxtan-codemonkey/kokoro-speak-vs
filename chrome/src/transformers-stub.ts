// kokoro-js imports these from @huggingface/transformers, but only to load its
// own model, which the extension never does: it keeps kokoro-js's text cleanup
// and phonemizer and runs our model itself. Aliasing transformers.js to this
// stub (chrome/build.mjs) keeps it, and the older onnxruntime-web it bundles,
// out of the extension.
const unused = () => {
  throw new Error("transformers.js is not bundled in the Chrome extension");
};
export const StyleTextToSpeech2Model = { from_pretrained: unused };
export const AutoTokenizer = { from_pretrained: unused };
export class Tensor {
  constructor() {
    unused();
  }
}
export class RawAudio {}
export const env = { backends: { onnx: { wasm: {} } } };
