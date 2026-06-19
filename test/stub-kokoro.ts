// Test stub for kokoro-js: returns a tiny silent WAV instantly so the playback
// state machine in webview/main.ts can be exercised in a headless browser
// without loading the 21MB runtime or downloading the model.

function encodeWav(samples: Float32Array, rate = 24000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, samples.length * 2, true);
  return buf;
}

export class TextSplitterStream {
  _text = "";
  _closed = false;
  push(...texts: string[]) {
    this._text += texts.join("");
  }
  close() {
    this._closed = true;
  }
}

export class KokoroTTS {
  voices = { af_heart: 1 };
  static async from_pretrained(): Promise<KokoroTTS> {
    return new KokoroTTS();
  }
  async generate(_text: string, _opts?: unknown) {
    const samples = new Float32Array(2400); // ~0.1s silence at 24kHz
    return {
      audio: samples,
      sampling_rate: 24000,
      toWav: () => encodeWav(samples, 24000),
    };
  }

  // Mirror kokoro-js: split into "sentences" and yield one audio per chunk.
  // (push/close happen before iteration in our flow, so reading _text is fine.)
  async *stream(splitter: TextSplitterStream | string, _opts?: unknown) {
    const text =
      typeof splitter === "string" ? splitter : splitter._text;
    const parts = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
    for (const part of parts.length ? parts : [String(text)]) {
      const samples = new Float32Array(2400); // ~0.1s each
      yield {
        text: part,
        phonemes: "",
        audio: { audio: samples, sampling_rate: 24000, toWav: () => encodeWav(samples, 24000) },
      };
    }
  }
}
