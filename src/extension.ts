import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getSpeakableText } from "./textprep";
import { AudioPlayer, PlayState } from "./player";

// The webview synthesizes (WASM) and sends WAV bytes; the host plays them via the
// OS audio player. This avoids the webview autoplay-gesture restriction and never
// needs the panel to hold focus, so editor selection capture stays correct.

const HELLO_TEXT =
  "Hello from Kokoro Speak. This sentence is being synthesized by the Kokoro 82 million parameter model.";

type Phase =
  | "idle"
  | "loading"
  | "synthesizing"
  | "speaking"
  | "paused"
  | "error";

let panel: vscode.WebviewPanel | undefined;
let status: vscode.StatusBarItem;
const player = new AudioPlayer();

// Streaming playback: chunks arrive from the webview as they synthesize and play
// in order. `queue` holds not-yet-played temp files; `current` is playing.
let queue: string[] = [];
let current: string | undefined;
let playing = false;
let synthDone = false;
// Request id so chunks from a superseded/stopped request are ignored.
let reqSeq = 0;
let activeReq = 0;

export function activate(context: vscode.ExtensionContext) {
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  status.command = "kokoroSpeak.stop";
  setStatus("idle");
  context.subscriptions.push(status);

  const speak = (text: string | undefined, what: string) => {
    const trimmed = text?.trim();
    if (!trimmed) {
      vscode.window.showInformationMessage("Kokoro Speak: nothing to speak.");
      return;
    }
    ensurePanel(context);
    // preserveFocus: keep the editor focused so selection stays intact.
    panel!.reveal(vscode.ViewColumn.Beside, true);
    const cfg = vscode.workspace.getConfiguration("kokoroSpeak");
    const voice = cfg.get<string>("voice", "af_heart");
    const speed = cfg.get<number>("speed", 1.0);
    resetPlayback();
    activeReq = ++reqSeq;
    setStatus("synthesizing", `Synthesizing ${what}…`);
    panel!.webview.postMessage({
      type: "synthesize",
      text: trimmed,
      voice,
      speed,
      reqId: activeReq,
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("kokoroSpeak.speakSelection", () => {
      const src = resolveSource();
      if (!src) {
        vscode.window.showInformationMessage(
          "Kokoro Speak: open a text file or Markdown document to speak."
        );
        return;
      }
      speak(getSpeakableText(src.document.languageId, src.text), src.kind);
    }),

    vscode.commands.registerCommand("kokoroSpeak.speakDocument", () => {
      const src = resolveSource({ wholeOnly: true });
      if (!src) {
        vscode.window.showInformationMessage(
          "Kokoro Speak: open a text file or Markdown document to speak."
        );
        return;
      }
      speak(getSpeakableText(src.document.languageId, src.text), "document");
    }),

    vscode.commands.registerCommand("kokoroSpeak.pause", () => {
      if (!player.isActive) return;
      const s = player.togglePause();
      setStatus(s === "paused" ? "paused" : "speaking");
    }),

    vscode.commands.registerCommand("kokoroSpeak.stop", () => {
      activeReq = ++reqSeq; // invalidate any in-flight chunks
      panel?.webview.postMessage({ type: "cancel" });
      resetPlayback();
      setStatus("idle");
    }),

    vscode.commands.registerCommand("kokoroSpeak.speakHello", () =>
      speak(HELLO_TEXT, "greeting")
    ),

    vscode.commands.registerCommand("kokoroSpeak.selectVoice", async () => {
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
        await cfg.update(
          "voice",
          pick.label,
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          `Kokoro Speak: voice set to ${pick.label}.`
        );
      }
    })
  );
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

export function deactivate() {
  resetPlayback();
  panel?.dispose();
}

/**
 * What to speak. Normally the active editor's selection (or whole doc). When
 * focus is in a webview (e.g. Markdown preview) there is no active text editor,
 * so fall back to the underlying document — preferring a visible Markdown doc.
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

function ensurePanel(context: vscode.ExtensionContext) {
  if (panel) return;
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel(
    "kokoroSpeak",
    "Kokoro Speak",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    }
  );
  panel.onDidDispose(() => {
    panel = undefined;
    resetPlayback();
    setStatus("idle");
  });

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "status") {
      // Webview reports loading / synthesizing progress only.
      if (msg.state === "loading" || msg.state === "synthesizing") {
        setStatus(msg.state as Phase, msg.detail);
      }
    } else if (msg?.type === "audio") {
      if (msg.reqId !== activeReq) return; // stale chunk from a prior request
      enqueueWav(msg.b64 as string);
    } else if (msg?.type === "audioEnd") {
      if (msg.reqId !== activeReq) return;
      synthDone = true;
      if (!playing && queue.length === 0) setStatus("idle");
    } else if (msg?.type === "error") {
      setStatus("error");
      vscode.window.showErrorMessage(`Kokoro Speak: ${msg.text}`);
    }
  });

  const mainUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "main.js")
  );
  const ortBase =
    panel.webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "ort"))
      .toString() + "/";
  panel.webview.html = getHtml(panel.webview, mainUri, ortBase);
}

let tempSeq = 0;

function enqueueWav(b64: string) {
  const file = path.join(
    os.tmpdir(),
    `kokoro-speak-${process.pid}-${tempSeq++}.wav`
  );
  try {
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
  } catch (err: any) {
    setStatus("error");
    vscode.window.showErrorMessage(`Kokoro Speak: ${err?.message ?? err}`);
    return;
  }
  queue.push(file);
  if (!playing) playNext();
}

function playNext() {
  const file = queue.shift();
  if (!file) {
    playing = false;
    if (synthDone) setStatus("idle");
    return;
  }
  playing = true;
  current = file;
  setStatus("speaking");
  player.play(
    file,
    () => {
      rmFile(file);
      if (current === file) current = undefined;
      playNext();
    },
    () => {
      resetPlayback();
      setStatus("error");
      vscode.window.showErrorMessage(
        "Kokoro Speak: no audio player found. Install one " +
          "(macOS: afplay built-in; Linux: paplay/aplay/ffplay)."
      );
    }
  );
}

/** Stop playback, drop the queue, and delete every temp file. */
function resetPlayback() {
  player.stop();
  playing = false;
  synthDone = false;
  if (current) {
    rmFile(current);
    current = undefined;
  }
  for (const f of queue) rmFile(f);
  queue = [];
}

function rmFile(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
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
  status.tooltip =
    phase === "idle" ? "Kokoro Speak" : "Kokoro Speak — click to stop";
  status.show();
}

function getHtml(
  webview: vscode.Webview,
  mainUri: vscode.Uri,
  ortBase: string
): string {
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval' blob:`,
    `worker-src ${webview.cspSource} blob:`,
    // Local ORT (.wasm via cspSource) + model weights from huggingface.co.
    `connect-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kokoro Speak</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 1rem; }
    #log { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
           font-size: 12px; opacity: 0.8; margin-top: 1rem; }
    .hint { opacity: .7; font-size: 12px; }
  </style>
</head>
<body data-ort-base="${ortBase}">
  <strong>Kokoro Speak</strong>
  <p id="state">Idle.</p>
  <p class="hint">Audio plays through your system. Use the status bar or
    Stop (Cmd/Ctrl+Alt+X) and Pause (Cmd/Ctrl+Alt+P) to control playback.</p>
  <div id="log"></div>
  <script type="module" src="${mainUri}"></script>
</body>
</html>`;
}
