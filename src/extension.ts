import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getSpeakableText } from "./textprep";
import { StreamPlayer } from "./player";
import { loadModel, synthesize } from "./synth";
import { normalize, NormMode, SEED_RULES } from "./normalize";

const SECRET_KEY = "kokoroSpeak.normalization.apiKey";
const CONSENT_KEY = "kokoroSpeak.aiConsent";

// Synthesis runs in the extension host (onnxruntime-node, ~3x realtime) and audio
// plays through the OS player. No webview: no CSP, no autoplay gesture, no panel.

const HELLO_TEXT =
  "Hello from Kokoro Speak. This sentence is synthesized by the Kokoro 82 million parameter model, running in the extension host.";

type Phase =
  | "idle"
  | "loading"
  | "synthesizing"
  | "speaking"
  | "paused"
  | "error";

let status: vscode.StatusBarItem;
let player: StreamPlayer | undefined;
let modelReady = false;
let extContext: vscode.ExtensionContext;
let tempSeq = 0;
// Request id so segments from a superseded/stopped request are ignored.
let reqSeq = 0;
let activeReq = 0;

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  status.command = "kokoroSpeak.stop";
  setStatus("idle");
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("kokoroSpeak.speakSelection", () => {
      const src = resolveSource();
      if (!src) return noSource();
      speak(getSpeakableText(src.document.languageId, src.text), src.kind);
    }),
    vscode.commands.registerCommand("kokoroSpeak.speakDocument", () => {
      const src = resolveSource({ wholeOnly: true });
      if (!src) return noSource();
      speak(getSpeakableText(src.document.languageId, src.text), "document");
    }),
    vscode.commands.registerCommand("kokoroSpeak.pause", () => {
      if (!player?.isActive) return;
      const s = player.togglePause();
      setStatus(s === "paused" ? "paused" : "speaking");
    }),
    vscode.commands.registerCommand("kokoroSpeak.stop", () => {
      activeReq = ++reqSeq; // invalidate in-flight synthesis + segments
      player?.stop();
      player = undefined;
      setStatus("idle");
    }),
    vscode.commands.registerCommand("kokoroSpeak.selectVoice", selectVoice),
    vscode.commands.registerCommand("kokoroSpeak.setApiKey", setApiKey),
    vscode.commands.registerCommand("kokoroSpeak.speakHello", () =>
      speak(HELLO_TEXT, "greeting")
    )
  );
}

async function setApiKey() {
  const key = await vscode.window.showInputBox({
    title: "Kokoro Speak — Normalization API Key",
    prompt: "Anthropic API key for 'api' normalization backend (stored in Secret Storage)",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  if (key === "") {
    await extContext.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage("Kokoro Speak: normalization API key cleared.");
  } else {
    await extContext.secrets.store(SECRET_KEY, key);
    vscode.window.showInformationMessage("Kokoro Speak: normalization API key saved.");
  }
}

/** First-use consent for AI normalization (sends text to a model). */
async function resolveAiConsent(): Promise<boolean> {
  const state = extContext.globalState.get<string>(CONSENT_KEY);
  if (state === "yes") return true;
  if (state === "no") return false;
  const pick = await vscode.window.showInformationMessage(
    "Kokoro Speak: AI normalization rewrites text for speech by sending the text " +
      "you speak to a local CLI agent or the Claude API. Enable it? " +
      "(You can change this in settings.)",
    { modal: true },
    "Enable",
    "Use offline rules only"
  );
  const ok = pick === "Enable";
  await extContext.globalState.update(CONSENT_KEY, ok ? "yes" : "no");
  return ok;
}

export function deactivate() {
  activeReq = ++reqSeq;
  player?.stop();
  player = undefined;
}

function noSource() {
  vscode.window.showInformationMessage(
    "Kokoro Speak: open a text file or Markdown document to speak."
  );
}

function speak(text: string | undefined, what: string) {
  const trimmed = text?.trim();
  if (!trimmed) {
    vscode.window.showInformationMessage("Kokoro Speak: nothing to speak.");
    return;
  }
  const cfg = vscode.workspace.getConfiguration("kokoroSpeak");
  const voice = cfg.get<string>("voice", "af_heart");
  const speed = cfg.get<number>("speed", 1.0);
  const bufferSeconds = cfg.get<number>("bufferSeconds", 0);

  player?.stop();
  const myReq = (activeReq = ++reqSeq);
  const cancelled = () => myReq !== activeReq;

  const sp = new StreamPlayer({
    onSpeaking: () => !cancelled() && setStatus("speaking"),
    onIdle: () => !cancelled() && setStatus("idle"),
    onUnavailable: () => {
      if (cancelled()) return;
      setStatus("error");
      vscode.window.showErrorMessage(
        "Kokoro Speak: no audio player found. Install one " +
          "(macOS: afplay built-in; Linux: paplay/aplay/ffplay)."
      );
    },
  });
  player = sp;

  void (async () => {
    try {
      const speakText = await prepareText(trimmed, what, cancelled);
      if (cancelled()) return;
      if (!speakText.trim()) {
        setStatus("idle");
        return;
      }
      if (!modelReady) {
        setStatus("loading", "Loading model…");
        await loadModel((pct) =>
          setStatus("loading", `Downloading model: ${pct}%`)
        );
        modelReady = true;
        if (cancelled()) return;
      }
      setStatus("synthesizing", `Synthesizing ${what}…`);
      await synthesize(
        speakText,
        { voice, speed, bufferSeconds },
        {
          onSegment: (wav, dur) => {
            if (cancelled()) return;
            sp.add(writeTemp(wav), dur);
          },
          onProgress: (n) => {
            if (!cancelled() && !sp.isActive) {
              setStatus("synthesizing", `Synthesizing ${what}… (${n})`);
            }
          },
          shouldCancel: cancelled,
        }
      );
      if (!cancelled()) sp.end();
    } catch (err: any) {
      if (cancelled()) return;
      setStatus("error");
      vscode.window.showErrorMessage(
        `Kokoro Speak: ${err?.message ?? String(err)}`
      );
    }
  })();
}

/** Normalize text for speech per settings (Markdown was already stripped). */
async function prepareText(
  text: string,
  what: string,
  cancelled: () => boolean
): Promise<string> {
  const ncfg = vscode.workspace.getConfiguration("kokoroSpeak.normalization");
  let mode = ncfg.get<NormMode>("mode", "deterministic");
  if (mode === "off") return text;

  if (mode === "ai") {
    const ok = await resolveAiConsent();
    if (cancelled()) return text;
    if (!ok) mode = "deterministic";
    else setStatus("synthesizing", `Preparing ${what}…`);
  }

  return normalize(text, {
    mode,
    rules: ncfg.get<string>("rules", SEED_RULES),
    replacements: ncfg.get("replacements", []),
    backend: ncfg.get("backend", "auto"),
    command: ncfg.get<string>("command", ""),
    model: ncfg.get<string>("model", "claude-haiku-4-5"),
    apiKey: await extContext.secrets.get(SECRET_KEY),
    timeoutMs: ncfg.get<number>("timeoutMs", 20000),
  });
}

async function selectVoice() {
  const cfg = vscode.workspace.getConfiguration("kokoroSpeak");
  const current = cfg.get<string>("voice", "af_heart");
  const pick = await vscode.window.showQuickPick(
    VOICES.map((v) => ({
      label: v,
      description: v === current ? "current" : undefined,
    })),
    { placeHolder: "Select a Kokoro voice" }
  );
  if (pick) {
    await cfg.update("voice", pick.label, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `Kokoro Speak: voice set to ${pick.label}.`
    );
  }
}

/**
 * What to speak: the active editor's selection (or whole doc). When focus is in
 * a webview such as the Markdown preview there is no active text editor, so fall
 * back to the underlying document, preferring a visible Markdown doc.
 */
function resolveSource(opts?: {
  wholeOnly?: boolean;
}): { document: vscode.TextDocument; text: string; kind: string } | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) {
    if (!opts?.wholeOnly && !active.selection.isEmpty) {
      return {
        document: active.document,
        text: active.document.getText(active.selection),
        kind: "selection",
      };
    }
    return {
      document: active.document,
      text: active.document.getText(),
      kind: "document",
    };
  }
  const candidates = [
    ...vscode.window.visibleTextEditors.map((e) => e.document),
    ...vscode.workspace.textDocuments,
  ].filter((d) => !d.isUntitled && d.uri.scheme === "file");
  const doc =
    candidates.find((d) => d.languageId === "markdown") ?? candidates[0];
  return doc
    ? { document: doc, text: doc.getText(), kind: "document" }
    : undefined;
}

/** Write a WAV segment to a unique temp file and return its path. */
function writeTemp(wav: Buffer): string {
  const file = path.join(
    os.tmpdir(),
    `kokoro-speak-${process.pid}-${tempSeq++}.wav`
  );
  fs.writeFileSync(file, wav);
  return file;
}

function setStatus(phase: Phase, detail?: string) {
  if (!status) return;
  const map: Record<Phase, { icon: string; label: string }> = {
    idle: { icon: "unmute", label: "Kokoro" },
    loading: { icon: "loading~spin", label: "Loading model" },
    synthesizing: { icon: "loading~spin", label: "Synthesizing" },
    speaking: { icon: "debug-pause", label: "Speaking" },
    paused: { icon: "play", label: "Paused" },
    error: { icon: "error", label: "Error" },
  };
  const { icon, label } = map[phase];
  status.text = `$(${icon}) ${detail ?? label}`;
  // Left click runs the command (Stop). Right-click isn't supported on status
  // items, so Pause/Resume is offered as a trusted command link in the tooltip.
  const active = phase === "speaking" || phase === "paused";
  const tip = new vscode.MarkdownString(undefined, true);
  tip.isTrusted = true;
  tip.appendMarkdown("**Kokoro Speak** — left-click to stop\n\n");
  if (active) {
    const pl = phase === "paused" ? "$(play) Resume" : "$(debug-pause) Pause";
    tip.appendMarkdown(`[${pl}](command:kokoroSpeak.pause) · `);
  }
  tip.appendMarkdown("[$(debug-stop) Stop](command:kokoroSpeak.stop)");
  status.tooltip = tip;
  status.show();
}

// Kokoro v1.0 voices (a=American, b=British; f=female, m=male).
const VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
  "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];
