import * as vscode from "vscode";
import * as path from "path";
import { getSpeakableText } from "./textprep";
import { profileFor, CodeReading } from "./codeprep";
import { AudioPlayer, AudioCallbacks, createPlayer } from "./pcmplayer";
import {
  loadModel,
  synthesize,
  setModelSource,
  REQUIRED_MODEL_FILES,
  MODEL_REPO_URL,
} from "./synth";
import { VOICES, isVoice } from "./voices";
import {
  normalize,
  NormMode,
  SEED_RULES,
  callBackend,
  hasBackend,
  BackendOptions,
} from "./normalize";

const SECRET_KEY = "kokoroSpeak.normalization.apiKey";
const CONSENT_KEY = "kokoroSpeak.aiConsent";
const NORM_KEYS = [
  "mode",
  "rules",
  "replacements",
  "spellOut",
  "backend",
  "command",
  "model",
  "timeoutMs",
].map((k) => "kokoroSpeak.normalization." + k);

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
let player: AudioPlayer | undefined;
let currentPhase: Phase = "idle";
let modelReady = false;
let extContext: vscode.ExtensionContext;
// Request id so segments from a superseded/stopped request are ignored.
let reqSeq = 0;
let activeReq = 0;

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  status.command = "kokoroSpeak.statusClick";
  setStatus("idle");
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("kokoroSpeak.speakSelection", () => {
      const src = resolveSource();
      if (!src) return noSource();
      speak(src.text, src.kind, src.document.languageId);
    }),
    vscode.commands.registerCommand("kokoroSpeak.speakDocument", () => {
      const src = resolveSource({ wholeOnly: true });
      if (!src) return noSource();
      speak(src.text, "document", src.document.languageId);
    }),
    vscode.commands.registerCommand("kokoroSpeak.speakClipboard", async () => {
      // Works from anywhere — including webview panels (Claude Code, Markdown
      // preview) whose text the extension can't read directly. Copy, then run
      // this. Clipboard text is usually Markdown (origin file type unknown), so
      // it's normalized as prose.
      const clip = await vscode.env.clipboard.readText();
      if (!clip.trim()) {
        vscode.window.showInformationMessage("Kokoro Speak: clipboard is empty.");
        return;
      }
      speak(clip, "clipboard", "markdown");
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
    vscode.commands.registerCommand("kokoroSpeak.statusClick", () => {
      // Click toggles Pause/Resume while active; speaks the clipboard when idle.
      // Full controls live in the hover tooltip. (No floating popup.)
      if (player?.isActive) vscode.commands.executeCommand("kokoroSpeak.pause");
      else vscode.commands.executeCommand("kokoroSpeak.speakClipboard");
    }),
    vscode.commands.registerCommand("kokoroSpeak.selectVoice", selectVoice),
    vscode.commands.registerCommand("kokoroSpeak.setModelPath", () =>
      promptForModelDir()
    ),
    vscode.commands.registerCommand("kokoroSpeak.setApiKey", setApiKey),
    vscode.commands.registerCommand("kokoroSpeak.configure", configure),
    vscode.commands.registerCommand("kokoroSpeak.speakHello", () =>
      speak(HELLO_TEXT, "greeting", "plaintext")
    ),
    // Picking up a model-path change from Settings: drop the loaded model so the
    // next play re-resolves the source (custom path → bundled → download).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kokoroSpeak.modelPath")) modelReady = false;
    })
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
  // Dismissing (Escape) is undefined — don't persist a decision, so we ask again
  // next time. Only an explicit button press is remembered.
  if (pick === undefined) return false;
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

function speak(text: string | undefined, what: string, languageId = "markdown") {
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

  const cb: AudioCallbacks = {
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
  };
  // Prefer native PCM streaming (audify → CoreAudio): exact pause/resume, instant
  // stop, gapless, no temp files. Falls back to the file-based player if audify
  // can't load or there's no output device.
  const sp: AudioPlayer = createPlayer(cb);
  player = sp;

  // Show "we're on it" synchronously, the instant play is pressed — prepareText
  // (AI normalization) and the first model load can take a moment, and otherwise
  // the status bar wouldn't change until after them.
  setStatus("synthesizing", `Preparing ${what}…`);

  void (async () => {
    try {
      const speakText = await prepareText(trimmed, what, cancelled, languageId);
      if (cancelled()) return;
      if (!speakText.trim()) {
        setStatus("idle");
        return;
      }
      if (!modelReady) {
        const loaded = await ensureModelLoaded(cancelled);
        if (!loaded || cancelled()) return;
      }
      setStatus("synthesizing", `Synthesizing ${what}…`);
      await synthesize(
        speakText,
        { voice, speed, bufferSeconds },
        {
          onSegment: (wav, dur) => {
            if (cancelled()) return;
            sp.push(wav, dur);
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

/** Current configured local model folder (empty = use bundled / download). */
function configuredModelPath(): string {
  return (
    vscode.workspace.getConfiguration("kokoroSpeak").get<string>("modelPath") ??
    ""
  ).trim();
}

/** The model bundled inside the extension (works fully offline, zero config). */
function bundledModelDir(): string {
  return path.join(extContext.extensionUri.fsPath, "model");
}

/**
 * Pick where to load the model from, in priority order:
 *   1. an explicit `kokoroSpeak.modelPath` (user override / custom install),
 *   2. the bundled model shipped in the extension (offline, default),
 *   3. undefined → download from HuggingFace (only if the bundle is absent).
 */
async function resolveModelDir(): Promise<string | undefined> {
  const configured = configuredModelPath();
  if (configured) return configured;
  const bundled = bundledModelDir();
  return (await verifyModelDir(bundled)).length ? undefined : bundled;
}

/**
 * Load the model, recovering from a failure (e.g. a blocked download when no
 * bundle is present) by walking the user through a manual install and retrying.
 * Returns true once the model is ready; false if the user gave up (status left
 * on "error").
 */
async function ensureModelLoaded(cancelled: () => boolean): Promise<boolean> {
  let dir = await resolveModelDir();
  setModelSource(dir);
  for (;;) {
    try {
      setStatus("loading", "Loading model…");
      await loadModel((pct) => {
        if (cancelled()) return;
        // Only an online fetch shows a download percentage; local loads are fast.
        setStatus("loading", dir ? "Loading model…" : `Downloading model: ${pct}%`);
      });
      modelReady = true;
      return true;
    } catch (err: any) {
      if (cancelled()) return false;
      setStatus("error");
      const picked = await promptForModelDir(err);
      if (cancelled() || !picked) return false; // declined — leave error shown
      dir = picked; // verified + saved; loop retries against the local files
    }
  }
}

/** Render a list as indented bullets for a message body. */
const bullets = (items: string[]): string =>
  items.map((f) => "  • " + f).join("\n");

/** Files a manual install must contain, as a bullet list for messages. */
const REQUIRED_FILES_LIST = bullets(REQUIRED_MODEL_FILES);

function manualInstallInstructions(reason?: string): string {
  return (
    (reason ? reason + "\n\n" : "") +
    "To install the Kokoro model manually (no internet needed on this machine):\n\n" +
    `1. On a machine with internet, open:\n   ${MODEL_REPO_URL}\n\n` +
    "2. Download these files, keeping the onnx/ subfolder layout:\n" +
    REQUIRED_FILES_LIST +
    "\n\n3. Put them together in one folder (any name).\n" +
    "4. Copy that folder to this machine, then select it next."
  );
}

/** Check a folder has every required model file; returns the missing ones. */
async function verifyModelDir(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const rel of REQUIRED_MODEL_FILES) {
    const uri = vscode.Uri.file(path.join(dir, ...rel.split("/")));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      missing.push(rel);
    }
  }
  return missing;
}

/**
 * Show manual-install instructions, let the user pick a folder, verify it, and
 * on success persist it (settings + live model source). Returns the verified
 * folder, or undefined if the user cancelled or chose to edit settings by hand.
 */
async function promptForModelDir(err?: unknown): Promise<string | undefined> {
  const reason = err
    ? `Kokoro Speak couldn't load the model: ${
        (err as any)?.message ?? String(err)
      }`
    : undefined;
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      manualInstallInstructions(reason),
      { modal: true },
      "Select Model Folder…",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "kokoroSpeak.modelPath"
      );
      return undefined;
    }
    if (choice !== "Select Model Folder…") return undefined; // dismissed

    const sel = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Use this model folder",
      title: "Select the folder containing the Kokoro model files",
    });
    if (!sel?.length) continue; // back to the instructions

    const dir = sel[0].fsPath;
    const missing = await verifyModelDir(dir);
    if (missing.length) {
      const retry = await vscode.window.showErrorMessage(
        `That folder is missing required files:\n${bullets(
          missing
        )}\n\nSelect the folder that directly contains config.json and the onnx/ subfolder.`,
        { modal: true },
        "Try Again"
      );
      if (retry !== "Try Again") return undefined;
      continue;
    }

    await vscode.workspace
      .getConfiguration("kokoroSpeak")
      .update("modelPath", dir, vscode.ConfigurationTarget.Global);
    setModelSource(dir);
    modelReady = false; // force a reload from the new local files
    vscode.window.showInformationMessage(
      "Kokoro Speak: model folder verified and saved."
    );
    return dir;
  }
}

async function backendOptions(): Promise<BackendOptions> {
  const n = vscode.workspace.getConfiguration("kokoroSpeak.normalization");
  return {
    backend: n.get("backend", "auto"),
    command: n.get<string>("command", ""),
    model: n.get<string>("model", "claude-haiku-4-5"),
    apiKey: await extContext.secrets.get(SECRET_KEY),
    // Config is interactive; give the (slow) CLI room.
    timeoutMs: Math.max(60000, n.get<number>("timeoutMs", 20000)),
  };
}

function openSettingsUi() {
  vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "kokoroSpeak.normalization"
  );
}

/**
 * Extract the first valid JSON object from an LLM response, tolerating code
 * fences and prose (incl. stray braces) around it. Scans each '{' as a start,
 * tracks brace depth (string-aware), and returns the first balanced slice that
 * parses.
 */
function parseJsonObject(s: string): any | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  for (let start = body.indexOf("{"); start >= 0; start = body.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          break; // not valid from this start; try the next '{'
        }
      }
    }
  }
  return null;
}

/** AI-driven configuration, instructed by skills/normalization-config.md. */
async function configure() {
  let skill = "";
  try {
    const uri = vscode.Uri.joinPath(
      extContext.extensionUri,
      "skills",
      "normalization-config.md"
    );
    skill = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    /* skill missing — fall back below */
  }

  const opts = await backendOptions();
  if (!skill || !hasBackend(opts)) {
    const pick = await vscode.window.showInformationMessage(
      "Kokoro Speak: AI configuration needs a normalization backend (a local " +
        "claude/codex CLI, or an API key). Open settings to configure manually?",
      "Open Settings"
    );
    if (pick) openSettingsUi();
    return;
  }

  const n = vscode.workspace.getConfiguration("kokoroSpeak.normalization");
  const current: Record<string, unknown> = {};
  for (const key of NORM_KEYS) {
    current[key] = n.get(key.replace("kokoroSpeak.normalization.", ""));
  }
  const top = vscode.workspace.getConfiguration("kokoroSpeak");
  current["kokoroSpeak.voice"] = top.get("voice");
  current["kokoroSpeak.speed"] = top.get("speed");

  // Give the AI the voice catalog so it can map "British male" → a real id.
  const voicesHint =
    "Available kokoroSpeak.voice values (a=American, b=British; f=female, " +
    "m=male):\n" +
    VOICES.join(", ");

  // The AI drives the UI: each turn it returns a control to render (pick / multi
  // / input) or the final settings. Start with a kickoff so the first screen is
  // an AI-chosen menu, not an empty input box.
  let convo = "User just opened the configuration assistant (no request yet).";
  for (let round = 0; round < 6; round++) {
    const raw = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Kokoro Speak: thinking…" },
      () =>
        callBackend(
          skill,
          `${voicesHint}\n\nCurrent settings:\n${JSON.stringify(current, null, 2)}\n\nConversation so far:\n${convo}`,
          opts,
          2048
        )
    );
    if (raw == null) {
      vscode.window.showErrorMessage("Kokoro Speak: the configuration agent didn't respond.");
      return;
    }
    const obj = parseJsonObject(raw);
    if (!obj) {
      vscode.window.showErrorMessage("Kokoro Speak: couldn't parse the configuration response.");
      return;
    }

    if (obj.settings && typeof obj.settings === "object") {
      await applySettings(obj.settings, typeof obj.summary === "string" ? obj.summary : "");
      return;
    }

    const ask = normalizeAsk(obj.ask);
    if (!ask) return;
    const answer = await renderAsk(ask);
    if (answer === undefined) return; // user cancelled
    convo += `\nAssistant asked: ${ask.prompt}\nUser answered: ${answer}`;
  }
  vscode.window.showInformationMessage(
    "Kokoro Speak: configuration didn't converge — try again and be more specific."
  );
}

type Ask = { kind: "input" | "pick" | "multi"; prompt: string; options?: string[]; placeholder?: string };

/** Accept the AI's ask spec (object) or a bare string (treated as free text). */
function normalizeAsk(ask: any): Ask | null {
  if (typeof ask === "string") return { kind: "input", prompt: ask };
  if (ask && typeof ask.prompt === "string") {
    const kind = ask.kind === "pick" || ask.kind === "multi" ? ask.kind : "input";
    return { kind, prompt: ask.prompt, options: ask.options, placeholder: ask.placeholder };
  }
  return null;
}

/** Render the AI-chosen control natively; returns the answer or undefined if cancelled. */
async function renderAsk(ask: Ask): Promise<string | undefined> {
  if (ask.kind === "pick" && ask.options?.length) {
    const pick = await vscode.window.showQuickPick(ask.options, {
      title: "Kokoro Speak — Configure",
      placeHolder: ask.prompt,
      ignoreFocusOut: true,
    });
    return pick;
  }
  if (ask.kind === "multi" && ask.options?.length) {
    const picks = await vscode.window.showQuickPick(ask.options, {
      title: "Kokoro Speak — Configure",
      placeHolder: ask.prompt,
      canPickMany: true,
      ignoreFocusOut: true,
    });
    return picks ? picks.join(", ") : undefined;
  }
  return vscode.window.showInputBox({
    title: "Kokoro Speak — Configure",
    prompt: ask.prompt,
    placeHolder: ask.placeholder,
    ignoreFocusOut: true,
  });
}

// Validators per setting — the LLM's proposed values are untrusted; a wrong type
// or out-of-range value would corrupt playback/normalization, so only well-typed
// values are persisted (voice must be a real id; speed within range).
const NORM_VALID: Record<string, (v: unknown) => boolean> = {
  "kokoroSpeak.voice": (v) => typeof v === "string" && isVoice(v),
  "kokoroSpeak.speed": (v) => typeof v === "number" && v >= 0.5 && v <= 2.0,
  "kokoroSpeak.normalization.mode": (v) =>
    v === "off" || v === "deterministic" || v === "ai",
  "kokoroSpeak.normalization.rules": (v) => typeof v === "string",
  "kokoroSpeak.normalization.replacements": (v) => Array.isArray(v),
  "kokoroSpeak.normalization.spellOut": (v) =>
    Array.isArray(v) && v.every((x) => typeof x === "string"),
  "kokoroSpeak.normalization.backend": (v) =>
    v === "auto" || v === "cli" || v === "api",
  "kokoroSpeak.normalization.command": (v) => typeof v === "string",
  "kokoroSpeak.normalization.model": (v) => typeof v === "string",
  "kokoroSpeak.normalization.timeoutMs": (v) => typeof v === "number" && v >= 1000,
};

async function applySettings(settings: Record<string, unknown>, summary: string) {
  const entries = Object.entries(settings).filter(([k, v]) => NORM_VALID[k]?.(v));
  if (!entries.length) {
    vscode.window.showInformationMessage(
      "Kokoro Speak: no valid changes proposed."
    );
    return;
  }
  const list = entries
    .map(
      ([k, v]) =>
        `• ${k.replace("kokoroSpeak.normalization.", "").replace("kokoroSpeak.", "")} = ${preview(v)}`
    )
    .join("\n");
  const ok = await vscode.window.showInformationMessage(
    `Kokoro Speak${summary ? " — " + summary : ""}\n\nApply these changes?\n${list}`,
    { modal: true },
    "Apply"
  );
  if (ok !== "Apply") return;

  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const cfg = vscode.workspace.getConfiguration();
  for (const [k, v] of entries) await cfg.update(k, v, target);
  if (settings["kokoroSpeak.normalization.mode"] === "ai") {
    await extContext.globalState.update(CONSENT_KEY, "yes"); // explicit opt-in
  }
  vscode.window.showInformationMessage("Kokoro Speak: configuration updated.");
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

/**
 * Prepare `raw` for speech per file type + settings: structural cleanup
 * (Markdown strip / code comment handling) keyed on `languageId`, then
 * normalization with the matching profile and any per-language overrides.
 */
async function prepareText(
  raw: string,
  what: string,
  cancelled: () => boolean,
  languageId: string
): Promise<string> {
  const ncfg = vscode.workspace.getConfiguration("kokoroSpeak.normalization");
  const codeReading = ncfg.get<CodeReading>("codeReading", "all");
  const text = getSpeakableText(languageId, raw, codeReading);
  if (!text.trim()) return text;

  let mode = ncfg.get<NormMode>("mode", "deterministic");
  if (mode === "off") return text;

  if (mode === "ai") {
    const ok = await resolveAiConsent();
    if (cancelled()) return text;
    if (!ok) mode = "deterministic";
    // status already shows "Preparing …" from speak()
  }

  // Per-language overrides (kokoroSpeak.normalization.byLanguage[languageId])
  // merged over the defaults: extra replacements/spellOut, optional rules /
  // profile override.
  const byLang =
    ncfg.get<Record<string, LangOverride>>("byLanguage", {})?.[languageId] ?? {};
  const baseReplacements = ncfg.get<any[]>("replacements", []);
  const baseSpellOut = ncfg.get<string[]>("spellOut", []);

  return normalize(text, {
    mode,
    profile: byLang.profile ?? profileFor(languageId),
    languageId,
    rules:
      typeof byLang.rules === "string"
        ? byLang.rules
        : ncfg.get<string>("rules", SEED_RULES),
    replacements: [
      ...baseReplacements,
      ...(Array.isArray(byLang.replacements) ? byLang.replacements : []),
    ],
    spellOut: [
      ...baseSpellOut,
      ...(Array.isArray(byLang.spellOut) ? byLang.spellOut : []),
    ],
    backend: ncfg.get("backend", "auto"),
    command: ncfg.get<string>("command", ""),
    model: ncfg.get<string>("model", "claude-haiku-4-5"),
    apiKey: await extContext.secrets.get(SECRET_KEY),
    timeoutMs: ncfg.get<number>("timeoutMs", 20000),
  });
}

interface LangOverride {
  profile?: "prose" | "code";
  rules?: string;
  replacements?: any[];
  spellOut?: string[];
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


function setStatus(phase: Phase, detail?: string) {
  if (!status) return;
  currentPhase = phase;
  const map: Record<Phase, { icon: string; label: string }> = {
    idle: { icon: "unmute", label: "Kokoro TTS" },
    loading: { icon: "loading~spin", label: "Loading model" },
    synthesizing: { icon: "loading~spin", label: "Synthesizing" },
    speaking: { icon: "debug-pause", label: "Speaking" },
    paused: { icon: "play", label: "Paused" },
    error: { icon: "error", label: "Error" },
  };
  const { icon, label } = map[phase];
  status.text = `$(${icon}) ${detail ?? label}`;
  // Clicking the item toggles Pause/Resume (or speaks the clipboard when idle);
  // the full controls are trusted command links in this hover tooltip, since
  // status items support only a single click action and no right-click.
  const active = phase === "speaking" || phase === "paused";
  const tip = new vscode.MarkdownString(undefined, true);
  tip.isTrusted = true;
  tip.appendMarkdown("**Kokoro TTS**\n\n");
  // Primary hover action: speak whatever's on the clipboard (works from the
  // Claude Code panel, Markdown preview, anywhere — copy, then click).
  tip.appendMarkdown("[$(play) Speak clipboard](command:kokoroSpeak.speakClipboard)");
  if (active) {
    const pl = phase === "paused" ? "$(debug-continue) Resume" : "$(debug-pause) Pause";
    tip.appendMarkdown(` · [${pl}](command:kokoroSpeak.pause)`);
  }
  // Stop only when there is something to stop (loading/synthesizing/speaking/
  // paused) — not when idle/stopped.
  const stoppable = phase !== "idle" && phase !== "error";
  if (stoppable) {
    tip.appendMarkdown(" · [$(debug-stop) Stop](command:kokoroSpeak.stop)");
  }
  tip.appendMarkdown(" · [$(gear) Config](command:kokoroSpeak.configure)");
  // Manual/offline model install — primary recovery path when the download is
  // blocked; surfaced prominently while in the error state.
  if (phase === "error") {
    tip.appendMarkdown(
      " · [$(folder-opened) Set model path](command:kokoroSpeak.setModelPath)"
    );
  } else {
    tip.appendMarkdown(
      " · [$(folder) Model](command:kokoroSpeak.setModelPath)"
    );
  }
  tip.appendMarkdown(
    active
      ? "\n\n_Click to pause/resume._"
      : "\n\n_Click to speak the clipboard._"
  );
  status.tooltip = tip;
  status.show();
}
