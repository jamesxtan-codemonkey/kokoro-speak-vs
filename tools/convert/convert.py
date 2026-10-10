"""Convert the official Kokoro-82M v1.0 weights to the ONNX files Kokoro Speak ships.

    python tools/convert/convert.py --out models/kokoro-speak [--jobs N]

Source: hexgrad/Kokoro-82M (Apache-2.0) at a pinned revision, SHA-256 verified.
Output (validated against the official PyTorch model before it's written):

    frontend.onnx   fp32  text encoders + duration/pitch prediction (all LSTMs)
                          (input_ids, style, speed) -> asr, F0_pred, N_pred, duration
    decoder.onnx    fp16  iSTFTNet vocoder; harmonic source + STFT math kept fp32
                          (asr, F0_pred, N_pred, style) -> waveform
    config.json           official config (the phoneme vocabulary)
    manifest.json         provenance, file hashes, validation metrics

Why not the onnx-community conversion? Measured against the official model it
is ~3x further off than the official model's own run-to-run variation at fp32
(~44% louder), and ~9x at q8, which also changes timing. The differences come
from the export, not the weights:
  * kokoro's ONNX-friendly CustomSTFT approximates torch.stft/istft (replicate
    padding, no DC/Nyquist weighting, no window-envelope normalisation). We use
    an exact conv implementation instead (ExactSTFT, checked to ~1e-6).
  * int8 quantisation shifts the duration predictor. We keep fp32 there.
  * The official model's sine-source noise is kept (RandomNormalLike).
Why split in two? On DirectML (Windows GPU) the LSTM kernel re-plans for every
new sequence length (~1.8 s/sentence) while the vocoder convs are fast; the
runtime runs the frontend on CPU (~0.1 s) and the decoder on the GPU.
Exporter details: weight_norm is folded into plain weights, the LSTMs skip
pack_padded_sequence (an identity for one unpadded sequence, but lossy to
trace), and the token->frame alignment is a comparison matrix instead of
repeat_interleave (which exports as a slow Loop).
"""
import argparse, contextlib, hashlib, json, math, os, platform, sys, tempfile, time, warnings
import multiprocessing as mp
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import onnx
import onnxruntime as ort
from huggingface_hub import hf_hub_download

import kokoro
import kokoro.istftnet as istft
from kokoro import KModel

warnings.filterwarnings("ignore")

REPO = "hexgrad/Kokoro-82M"
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
SOURCES = {
    "config.json": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
    "kokoro-v1_0.pth": "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
}
VALIDATION_VOICE = "af_heart"
# "The quick brown fox jumps over the lazy dog. She sells seashells by the
# seashore on a sunny morning." through the official G2P (misaki) + vocab.
VALIDATION_IDS = [0, 81, 83, 16, 53, 65, 156, 102, 53, 16, 44, 123, 156, 39, 56, 16, 48, 156, 69, 53, 61, 16, 82, 156, 138, 55, 58, 61, 16, 156, 31, 64, 83, 123, 16, 81, 83, 16, 54, 156, 24, 68, 51, 16, 46, 156, 76, 92, 4, 16, 131, 157, 51, 16, 61, 156, 86, 54, 68, 16, 61, 156, 51, 131, 157, 86, 54, 68, 16, 44, 25, 16, 81, 83, 16, 61, 156, 51, 131, 157, 76, 123, 16, 157, 76, 56, 16, 70, 16, 61, 156, 138, 56, 51, 16, 55, 156, 76, 123, 56, 102, 112, 4, 0]
# Gates (spectral distance, see `dist`). The official model differs from itself
# by ~1.2 between random seeds; an exact re-implementation lands ~1.0 from it
# (float rounding feeds the vocoder's phase inputs, which amplify it).
MAX_FP32_DIST = 1.6
MAX_FP16_DIST = 2.5
MAX_RMS_DEV = 0.06


# --- exact STFT --------------------------------------------------------------
class ExactSTFT(nn.Module):
    """torch.stft/istft (center=True, reflect pad, Hann, onesided) as conv ops."""

    def __init__(self, filter_length, hop_length, win_length):
        super().__init__()
        N = filter_length
        assert win_length == N
        self.n_fft, self.hop = N, hop_length
        w = torch.hann_window(N, periodic=True, dtype=torch.float64)
        k = torch.arange(N // 2 + 1, dtype=torch.float64)[:, None]
        n = torch.arange(N, dtype=torch.float64)[None, :]
        ang = 2 * math.pi * k * n / N
        self.register_buffer("fwd_re", (torch.cos(ang) * w).float().unsqueeze(1))
        self.register_buffer("fwd_im", (-torch.sin(ang) * w).float().unsqueeze(1))
        coef = torch.full((N // 2 + 1, 1), 2.0, dtype=torch.float64)
        coef[0] = 1.0
        if N % 2 == 0:
            coef[-1] = 1.0
        coef /= N
        self.register_buffer("inv_re", (coef * torch.cos(ang) * w).float().unsqueeze(1))
        self.register_buffer("inv_im", (coef * torch.sin(ang) * w).float().unsqueeze(1))
        self.register_buffer("win_sq", (w**2).float().view(1, 1, N))

    def transform(self, x):
        p = self.n_fft // 2
        x = F.pad(x.unsqueeze(1), (p, p), mode="reflect")
        re = F.conv1d(x, self.fwd_re, stride=self.hop)
        im = F.conv1d(x, self.fwd_im, stride=self.hop)
        mag = torch.sqrt(re * re + im * im)
        phase = torch.atan2(im, re)
        # ONNX's atan2 lowering differs from torch's at the branch cut / origin.
        phase = torch.where((im == 0) & (re < 0), torch.full_like(phase, math.pi), phase)
        phase = torch.where((im == 0) & (re == 0), torch.zeros_like(phase), phase)
        return mag, phase

    def inverse(self, mag, phase):
        re, im = mag * torch.cos(phase), mag * torch.sin(phase)
        y = F.conv_transpose1d(re, self.inv_re, stride=self.hop) - F.conv_transpose1d(im, self.inv_im, stride=self.hop)
        env = F.conv_transpose1d(torch.ones_like(re[:, :1, :]), self.win_sq, stride=self.hop)
        y = y / torch.where(env > 1e-11, env, torch.ones_like(env))
        p = self.n_fft // 2
        return y[..., p : y.shape[-1] - p]


# --- export helpers ------------------------------------------------------------
@contextlib.contextmanager
def no_noise():
    """Disable SineGen's random phase + noise (exact comparisons only)."""
    r, n = istft.torch.rand, istft.torch.randn_like
    istft.torch.rand = lambda *a, **k: torch.zeros(*a)
    istft.torch.randn_like = lambda t, **k: torch.zeros_like(t)
    try:
        yield
    finally:
        istft.torch.rand, istft.torch.randn_like = r, n


@contextlib.contextmanager
def unpacked_lstms():
    rnn = torch.nn.utils.rnn
    p, u = rnn.pack_padded_sequence, rnn.pad_packed_sequence
    rnn.pack_padded_sequence = lambda x, *a, **k: x
    rnn.pad_packed_sequence = lambda x, *a, **k: (x, None)
    try:
        yield
    finally:
        rnn.pack_padded_sequence, rnn.pad_packed_sequence = p, u


class Frontend(nn.Module):
    def __init__(self, m: KModel):
        super().__init__()
        self.m = m

    def forward(self, input_ids, style, speed):
        m = self.m
        n = input_ids.shape[-1]
        input_lengths = torch.full((1,), n, dtype=torch.long)
        text_mask = torch.zeros((1, n), dtype=torch.bool)  # batch 1, no padding
        bert_dur = m.bert(input_ids, attention_mask=(~text_mask).int())
        d_en = m.bert_encoder(bert_dur).transpose(-1, -2)
        s = style[:, 128:]
        d = m.predictor.text_encoder(d_en, s, input_lengths, text_mask)
        x, _ = m.predictor.lstm(d)
        duration = torch.sigmoid(m.predictor.duration_proj(x)).sum(axis=-1) / speed
        pred_dur = torch.round(duration).clamp(min=1).long().squeeze(0)
        # frame f belongs to token i iff cum[i] - dur[i] <= f < cum[i]
        cum = torch.cumsum(pred_dur, dim=0)
        frames = torch.arange(cum[-1])
        start = (cum - pred_dur).unsqueeze(1)
        aln = ((frames.unsqueeze(0) >= start) & (frames.unsqueeze(0) < cum.unsqueeze(1))).float().unsqueeze(0)
        en = d.transpose(-1, -2) @ aln
        F0_pred, N_pred = m.predictor.F0Ntrain(en, s)
        asr = m.text_encoder(input_ids, input_lengths, text_mask) @ aln
        return asr, F0_pred, N_pred, pred_dur


class Decoder(nn.Module):
    """The vocoder. half=True runs the network in fp16, keeping the harmonic
    source (cumulative phase -> sin), the STFT and the exp/sin of the output
    spectrum in fp32 (phase values grow large; fp16 would wreck them)."""

    def __init__(self, m: KModel, half: bool):
        super().__init__()
        self.d, self.half_ = m.decoder, half
        if half:
            self.d.half()
            self.d.generator.m_source.float()
            self.d.generator.stft.float()

    def forward(self, asr, F0_curve, N, style):
        d, g = self.d, self.d.generator
        cast = (lambda t: t.half()) if self.half_ else (lambda t: t)
        s = cast(style[:, :128])
        F0 = d.F0_conv(cast(F0_curve).unsqueeze(1))
        Nn = d.N_conv(cast(N).unsqueeze(1))
        a = cast(asr)
        x = d.encode(torch.cat([a, F0, Nn], axis=1), s)
        asr_res = d.asr_res(a)
        res = True
        for block in d.decode:
            if res:
                x = torch.cat([x, asr_res, F0, Nn], axis=1)
            x = block(x, s)
            if block.upsample_type != "none":
                res = False
        f0 = g.f0_upsamp(F0_curve[:, None]).transpose(1, 2)
        har_source, _, _ = g.m_source(f0)
        har_spec, har_phase = g.stft.transform(har_source.transpose(1, 2).squeeze(1))
        har = cast(torch.cat([har_spec, har_phase], dim=1))
        for i in range(g.num_upsamples):
            x = F.leaky_relu(x, negative_slope=0.1)
            x_source = g.noise_res[i](g.noise_convs[i](har), s)
            x = g.ups[i](x)
            if i == g.num_upsamples - 1:
                x = g.reflection_pad(x)
            x = x + x_source
            xs = None
            for j in range(g.num_kernels):
                r = g.resblocks[i * g.num_kernels + j](x, s)
                xs = r if xs is None else xs + r
            x = xs / g.num_kernels
        x = g.conv_post(F.leaky_relu(x)).float()
        spec = torch.exp(x[:, : g.post_n_fft // 2 + 1, :])
        phase = torch.sin(x[:, g.post_n_fft // 2 + 1 :, :])
        return g.stft.inverse(spec, phase).squeeze()


def load_official():
    paths = {}
    for name, sha in SOURCES.items():
        p = hf_hub_download(REPO, name, revision=REVISION)
        got = sha256(p)
        if got != sha:
            sys.exit(f"[convert] {name}: SHA-256 mismatch ({got})")
        paths[name] = p
    model = KModel(repo_id=REPO, config=paths["config.json"], model=paths["kokoro-v1_0.pth"]).eval()
    gen = model.decoder.generator
    gen.stft = ExactSTFT(gen.stft.filter_length, gen.stft.hop_length, gen.stft.win_length)
    for mod in model.modules():  # fold weight_norm: constant weights, same math
        if hasattr(mod, "weight_g"):
            torch.nn.utils.remove_weight_norm(mod)
    return model, paths


def export(module, args, path, inputs, outputs, axes):
    torch.onnx.export(module, args, path, input_names=inputs, output_names=outputs, dynamic_axes=axes,
                      opset_version=20, do_constant_folding=True, dynamo=False)


FE_IO = (["input_ids", "style", "speed"], ["asr", "F0_pred", "N_pred", "duration"],
         {"input_ids": {1: "tokens"}, "asr": {2: "frames"}, "F0_pred": {1: "frames2"}, "N_pred": {1: "frames2"}, "duration": {0: "tokens"}})
DE_IO = (["asr", "F0_pred", "N_pred", "style"], ["waveform"],
         {"asr": {2: "frames"}, "F0_pred": {1: "frames2"}, "N_pred": {1: "frames2"}, "waveform": {0: "samples"}})


# --- metrics -------------------------------------------------------------------
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dist(a, b, n=1024, hop=256):
    """Mean |log-power spectrogram difference| (x10, 'dB-ish')."""
    m = min(len(a), len(b))
    spec = lambda x: np.log10(np.abs(np.fft.rfft(np.lib.stride_tricks.sliding_window_view(x[:m], n)[::hop] * np.hanning(n), axis=-1)) ** 2 + 1e-10)
    return float(10 * np.mean(np.abs(spec(a) - spec(b))))


def rms(x):
    return float(np.sqrt(np.mean(np.square(x))))


def example_inputs():
    """Validation inputs: token ids, the official style row, speed."""
    voice = torch.load(hf_hub_download(REPO, f"voices/{VALIDATION_VOICE}.pt", revision=REVISION), weights_only=True)
    ids = torch.LongTensor([VALIDATION_IDS])
    style = voice[len(VALIDATION_IDS) - 3]  # official row: len(phonemes) - 1
    return ids, style, torch.FloatTensor([1.0])


# The four graphs. Each export is single-threaded (TorchScript tracing + ONNX
# graph passes), so they run as parallel worker processes.
#   frontend           shipped + validated (no random ops: one file serves both)
#   decoder            shipped: fp16, official noise on
#   decoder32_nonoise  validation: fp32 vocoder, noise off
#   decoder16_nonoise  validation: fp16 vocoder, noise off
def export_task(name, path):
    t0 = time.perf_counter()
    torch.set_num_threads(max(1, (os.cpu_count() or 4) // 4))
    model, _ = load_official()
    ids, style, speed = example_inputs()
    if name != "frontend":
        # Tracing runs one real forward pass, and fp16 convolutions on a CPU
        # are very slow; the axes are dynamic, so a few tokens trace the same
        # graph as a full sentence (~20x faster export).
        ids = ids[:, :12]
    with torch.no_grad(), unpacked_lstms():
        fe = Frontend(model).eval()
        if name == "frontend":
            export(fe, (ids, style, speed), path, *FE_IO)
        else:
            asr, f0, n_, _ = fe(ids, style, speed)
            dec = Decoder(model, half=name != "decoder32_nonoise").eval()
            with (no_noise() if name.endswith("_nonoise") else contextlib.nullcontext()):
                export(dec, (asr, f0, n_, style), path, *DE_IO)
    return name, time.perf_counter() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1),
                    help="parallel export processes (default: up to 4)")
    args = ap.parse_args()
    out = args.out
    os.makedirs(out, exist_ok=True)
    t_start = time.perf_counter()
    print(f"[convert] {REPO}@{REVISION[:7]} -> {out}")

    model, paths = load_official()  # downloads + verifies the sources once
    ids, style, speed = example_inputs()
    checks = {}

    # 1. ExactSTFT == torch.stft / istft
    x = torch.randn(1, 24000, generator=torch.Generator().manual_seed(0))
    ex, ts = ExactSTFT(20, 5, 20), istft.TorchSTFT(20, 5, 20)
    (m1, p1), (m2, p2) = ex.transform(x), ts.transform(x)
    dp = torch.remainder(p1 - p2 + math.pi, 2 * math.pi) - math.pi
    istft_err = float((ex.inverse(m2, p2) - ts.inverse(m2, p2)).abs().max())
    checks["stft_max_err"] = max(float((m1 - m2).abs().max()), float(dp.abs().max()), istft_err)
    print(f"[check] ExactSTFT vs torch.stft/istft: max err {checks['stft_max_err']:.1e}")
    assert checks["stft_max_err"] < 1e-3, "ExactSTFT does not match torch.stft"

    # 2. Reference (official PyTorch forward, noise off for a deterministic compare)
    with torch.no_grad(), no_noise():
        reference = model.forward_with_tokens(ids, style, 1.0)[0].numpy()
    del model

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        targets = {
            "frontend": f"{out}/frontend.onnx",
            "decoder": f"{out}/decoder.onnx",
            "decoder32_nonoise": f"{tmp}/de32.onnx",
            "decoder16_nonoise": f"{tmp}/de16.onnx",
        }
        t_exp = time.perf_counter()
        print(f"[convert] exporting {len(targets)} graphs with {args.jobs} worker process(es)")
        with ProcessPoolExecutor(max_workers=args.jobs, mp_context=mp.get_context("spawn")) as pool:
            for fut in as_completed([pool.submit(export_task, n, p) for n, p in targets.items()]):
                name, secs = fut.result()
                print(f"[convert]   {name}: {secs:.0f}s")
        checks["export_seconds"] = round(time.perf_counter() - t_exp, 1)

        # 3. Validate against the official model.
        so = ort.SessionOptions()
        so.log_severity_level = 3  # errors only
        sess = lambda p: ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])
        feeds = {"input_ids": ids.numpy(), "style": style.numpy(), "speed": speed.numpy()}
        a, f, nn_, _ = sess(targets["frontend"]).run(None, feeds)
        de_feeds = {"asr": a, "F0_pred": f, "N_pred": nn_, "style": feeds["style"]}
        wav32 = sess(targets["decoder32_nonoise"]).run(None, de_feeds)[0].reshape(-1)
        wav16 = sess(targets["decoder16_nonoise"]).run(None, de_feeds)[0].reshape(-1)
        shipped = sess(targets["decoder"]).run(None, de_feeds)[0].reshape(-1)

    checks["fp32_vs_official"] = dist(wav32, reference)
    checks["fp32_rms_ratio"] = rms(wav32) / rms(reference)
    checks["samples"] = [int(len(wav32)), int(len(reference))]
    print(f"[check] ONNX fp32 vs official PyTorch: dist {checks['fp32_vs_official']:.2f} (gate {MAX_FP32_DIST}), "
          f"rms ratio {checks['fp32_rms_ratio']:.3f}, samples {len(wav32)}/{len(reference)}")
    checks["fp16_vs_official"] = dist(wav16, reference)
    checks["fp16_rms_ratio"] = rms(wav16) / rms(reference)
    print(f"[check] ONNX fp16 decoder vs official PyTorch: dist {checks['fp16_vs_official']:.2f} (gate {MAX_FP16_DIST}), "
          f"rms ratio {checks['fp16_rms_ratio']:.3f}")
    checks["shipped_vs_official"] = dist(shipped, reference)
    print(f"[check] shipped pair (official noise on) vs official: dist {checks['shipped_vs_official']:.2f}")
    failed = []
    if len(wav32) != len(reference):
        failed.append("durations differ from the official model")
    if not (checks["fp32_vs_official"] < MAX_FP32_DIST and abs(checks["fp32_rms_ratio"] - 1) < MAX_RMS_DEV):
        failed.append("fp32 export is off from the official model")
    if not (checks["fp16_vs_official"] < MAX_FP16_DIST and abs(checks["fp16_rms_ratio"] - 1) < MAX_RMS_DEV):
        failed.append("fp16 decoder is off from the official model")
    if failed:  # never leave unvalidated files where packaging would pick them up
        for f_ in ("frontend.onnx", "decoder.onnx"):
            if os.path.exists(f"{out}/{f_}"):
                os.remove(f"{out}/{f_}")
        sys.exit("[convert] validation FAILED: " + "; ".join(failed))

    with open(paths["config.json"], "rb") as src, open(f"{out}/config.json", "wb") as dst:
        dst.write(src.read())
    files = {f: {"sha256": sha256(f"{out}/{f}"), "bytes": os.path.getsize(f"{out}/{f}")}
             for f in ["frontend.onnx", "decoder.onnx", "config.json"]}
    manifest = {
        "model": "Kokoro-82M v1.0 (split: frontend fp32 + decoder fp16)",
        "source": {"repo": REPO, "revision": REVISION, "license": "Apache-2.0", "files": SOURCES},
        "tools": {"python": platform.python_version(), "torch": torch.__version__, "kokoro": kokoro.__version__,
                  "onnx": onnx.__version__, "onnxruntime": ort.__version__},
        "files": files,
        "validation": checks,
    }
    with open(f"{out}/manifest.json", "w") as fp:
        json.dump(manifest, fp, indent=2)
    for f, info in files.items():
        print(f"[convert] {f}: {info['bytes'] / 1e6:.1f} MB")
    print(f"[convert] done in {time.perf_counter() - t_start:.0f}s")


if __name__ == "__main__":
    main()
