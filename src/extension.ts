import * as vscode from "vscode";
import { getSpeakableText } from "./textprep";

// M2 host: editor integration. Commands capture text from the active editor and
// drive a hidden-ish webview that runs Kokoro (WASM) and plays audio. A status
// bar item reflects playback state and offers stop.

const HELLO_TEXT =
  "Hello from Kokoro Speak. This sentence is being synthesized by the Kokoro 82 million parameter model, running entirely inside a VS Code webview.";

type PlaybackState =
  | "idle"
  | "loading"
  | "synthesizing"
  | "speaking"
  | "paused"
  | "done"
  | "error";

let panel: vscode.WebviewPanel | undefined;
let status: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  status.command = "kokoroSpeak.stop";
  setStatus("idle");
  context.subscriptions.push(status);

  const speak = (text: string | undefined) => {
    const trimmed = text?.trim();
    if (!trimmed) {
      vscode.window.showInformationMessage("Kokoro Speak: nothing to speak.");
      return;
    }
    ensurePanel(context);
    panel!.reveal(vscode.ViewColumn.Beside, true);
    setStatus("loading");
    panel!.webview.postMessage({ type: "speak", text: trimmed });
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
      speak(getSpeakableText(src.document.languageId, src.text));
    }),

    vscode.commands.registerCommand("kokoroSpeak.speakDocument", () => {
      const src = resolveSource({ wholeOnly: true });
      if (!src) {
        vscode.window.showInformationMessage(
          "Kokoro Speak: open a text file or Markdown document to speak."
        );
        return;
      }
      speak(getSpeakableText(src.document.languageId, src.text));
    }),

    vscode.commands.registerCommand("kokoroSpeak.pause", () => {
      panel?.webview.postMessage({ type: "pause" });
    }),

    vscode.commands.registerCommand("kokoroSpeak.stop", () => {
      panel?.webview.postMessage({ type: "stop" });
      setStatus("idle");
    }),

    vscode.commands.registerCommand("kokoroSpeak.speakHello", () =>
      speak(HELLO_TEXT)
    )
  );
}

export function deactivate() {
  panel?.dispose();
}

/**
 * Resolve what to speak. Normally the active editor's selection (or whole doc).
 * When focus is in a webview such as the Markdown preview there is no active
 * text editor, so fall back to the underlying document — preferring a visible
 * Markdown doc, then any open file-backed text document.
 */
function resolveSource(opts?: {
  wholeOnly?: boolean;
}): { document: vscode.TextDocument; text: string } | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) {
    if (!opts?.wholeOnly && !active.selection.isEmpty) {
      return {
        document: active.document,
        text: active.document.getText(active.selection),
      };
    }
    return { document: active.document, text: active.document.getText() };
  }

  const candidates = [
    ...vscode.window.visibleTextEditors.map((e) => e.document),
    ...vscode.workspace.textDocuments,
  ].filter((d) => !d.isUntitled && d.uri.scheme === "file");

  const doc =
    candidates.find((d) => d.languageId === "markdown") ?? candidates[0];
  return doc ? { document: doc, text: doc.getText() } : undefined;
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
    setStatus("idle");
  });

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "state") {
      setStatus(msg.state as PlaybackState, msg.detail);
    } else if (msg?.type === "error") {
      setStatus("error");
      vscode.window.showErrorMessage(`Kokoro Speak: ${msg.text}`);
    }
  });

  const mainUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "main.js")
  );
  // Local ONNX-Runtime-Web assets, so the webview never hits the jsdelivr CDN
  // (which its CSP blocks). Trailing slash: transformers.js appends filenames.
  const ortBase =
    panel.webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "ort"))
      .toString() + "/";
  panel.webview.html = getHtml(panel.webview, mainUri, ortBase);
}

function setStatus(state: PlaybackState, detail?: string) {
  if (!status) return;
  const map: Record<PlaybackState, { icon: string; label: string }> = {
    idle: { icon: "unmute", label: "Kokoro" },
    loading: { icon: "loading~spin", label: "Loading model" },
    synthesizing: { icon: "loading~spin", label: "Synthesizing" },
    speaking: { icon: "debug-pause", label: "Speaking" },
    paused: { icon: "play", label: "Paused" },
    done: { icon: "unmute", label: "Kokoro" },
    error: { icon: "error", label: "Error" },
  };
  const { icon, label } = map[state];
  status.text = `$(${icon}) ${detail ?? label}`;
  status.tooltip =
    state === "speaking" || state === "synthesizing" || state === "loading"
      ? "Kokoro Speak — click to stop"
      : "Kokoro Speak";
  status.show();
}

function getHtml(
  webview: vscode.Webview,
  mainUri: vscode.Uri,
  ortBase: string
): string {
  const csp = [
    `default-src 'none'`,
    // Local ORT loader .mjs is imported from the extension (cspSource).
    `script-src ${webview.cspSource} 'wasm-unsafe-eval' blob:`,
    `worker-src ${webview.cspSource} blob:`,
    // Local ORT .wasm (cspSource) + model weights from huggingface.co (https:).
    `connect-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `media-src ${webview.cspSource} blob: data:`,
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
    /* (ort base passed via body data attribute below) */
    .row { display: flex; gap: .5rem; align-items: center; margin: .5rem 0; }
    button { font: inherit; padding: .3rem .8rem; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    #log { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
           font-size: 12px; opacity: 0.8; margin-top: 1rem; }
  </style>
</head>
<body data-ort-base="${ortBase}">
  <div class="row"><strong>Kokoro Speak</strong></div>
  <p id="state">Idle.</p>
  <div class="row">
    <button id="pause" disabled>Pause</button>
    <button id="stop" disabled>Stop</button>
  </div>
  <div id="log"></div>
  <script type="module" src="${mainUri}"></script>
</body>
</html>`;
}
