import * as vscode from "vscode";

// M1 spike host: a single command that opens a webview, asks it to synthesize a
// hardcoded sentence with kokoro-js (WASM), and plays it. This validates the
// in-webview inference + playback path that the full extension will build on.

const HELLO_TEXT =
  "Hello from Kokoro Speak. This sentence is being synthesized by the Kokoro 82 million parameter model, running entirely inside a VS Code webview.";

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("kokoroSpeak.speakHello", () => {
      if (!panel) {
        panel = createPanel(context);
        panel.onDidDispose(() => (panel = undefined));
      }
      panel.reveal(vscode.ViewColumn.Beside);
      panel.webview.postMessage({ type: "speak", text: HELLO_TEXT });
    })
  );
}

export function deactivate() {
  panel?.dispose();
}

function createPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const p = vscode.window.createWebviewPanel(
    "kokoroSpeak",
    "Kokoro Speak",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    }
  );

  p.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "status") {
      vscode.window.setStatusBarMessage(`Kokoro: ${msg.text}`, 4000);
    } else if (msg?.type === "error") {
      vscode.window.showErrorMessage(`Kokoro Speak: ${msg.text}`);
    }
  });

  const mainUri = p.webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "main.js")
  );
  p.webview.html = getHtml(p.webview, mainUri);
  return p;
}

function getHtml(webview: vscode.Webview, mainUri: vscode.Uri): string {
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval' blob:`,
    `worker-src ${webview.cspSource} blob:`,
    // Model weights + ORT wasm are fetched from huggingface.co / CDN.
    `connect-src https: data: blob:`,
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
    #log { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
           font-size: 12px; opacity: 0.85; margin-top: 1rem; }
    .row { display: flex; gap: .5rem; align-items: center; }
    button { font: inherit; padding: .3rem .8rem; }
  </style>
</head>
<body>
  <div class="row">
    <strong>Kokoro Speak — M1 spike</strong>
  </div>
  <p id="state">Idle. Run the command to synthesize.</p>
  <div id="log"></div>
  <script type="module" src="${mainUri}"></script>
</body>
</html>`;
}
