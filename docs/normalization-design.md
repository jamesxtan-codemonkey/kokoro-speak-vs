# Normalization — design for review

> Status: proposal (no code yet). Covers M3 (deterministic + the customizable
> rules surface) and M4 (LLM backend). Implements the pre-processing idea from
> the original brief: "$10B → ten billion dollars … a set of rules an AI agent
> understands and processes at runtime."

## 1. Where it runs

One step in the extension host, between text capture and synthesis:

```
resolveSource (selection/document)
  → getSpeakableText()        // existing: strip Markdown
  → normalize()               // NEW: this design
  → synthesize()              // host Kokoro, streams sentences
  → StreamPlayer              // gapless playback
```

`normalize(text, opts) → Promise<string>` runs **once on the whole text**, before
sentence splitting. Rationale: full context for the LLM, and normalization can
change sentence boundaries (e.g. `e.g.`), so it must precede the splitter. New
module: `src/normalize.ts` (no `vscode` import, unit-testable like `synth.ts`).

Latency: deterministic mode adds ~0 ms. AI mode adds one round-trip **only when**
the gate finds candidates and the result isn't cached (see §5).

## 2. Modes (`kokoroSpeak.normalization.mode`)

| Mode            | Behavior                                                        |
|-----------------|----------------------------------------------------------------|
| `off`           | No normalization (Markdown strip still applies).               |
| `deterministic` | Built-in local rule engine only. Offline, instant, private. **Default.** |
| `ai`            | LLM applies the natural-language rules; deterministic is the fallback. |

Default is `deterministic` so it works out of the box with no setup, no network,
and nothing leaves the machine. `ai` is opt-in (it sends text to a model — §5.5).

## 3. The customizable surface

Everything is plain VS Code settings, so **each user customizes in their own
User settings, and a repo can override per-workspace** (`.vscode/settings.json`).

```jsonc
"kokoroSpeak.normalization.mode": "deterministic",      // off | deterministic | ai
"kokoroSpeak.normalization.rules": "<natural-language rules>",   // used by `ai`
"kokoroSpeak.normalization.replacements": [             // used by deterministic + ai
  { "from": "K8s", "to": "Kubernetes" },
  { "pattern": "\\bWIP\\b", "replacement": "work in progress", "flags": "g" }
],
"kokoroSpeak.normalization.backend": "auto",            // auto | cli | api
"kokoroSpeak.normalization.command": "",                // explicit CLI, e.g. "claude" or "codex"
"kokoroSpeak.normalization.model": "claude-haiku-4-5",  // api (and cli where settable)
"kokoroSpeak.normalization.timeoutMs": 8000
```

- **`rules`** — free natural-language text, the heart of `ai` mode. Ships seeded
  with the examples below; the user edits/extends it. Customizable per user.
- **`replacements`** — optional user-defined literal/regex substitutions applied
  by the **deterministic** engine (so offline mode is customizable too), and also
  applied before the LLM as a guaranteed pass. `from` = literal; or
  `pattern`+`flags` for regex.
- **API key** is **not** a setting — stored in VS Code SecretStorage, set via a
  `Kokoro Speak: Set Normalization API Key` command.

Seeded default `rules`:

```
- Currency: "$10B" → "10 billion dollars"; "$3.5M" → "3.5 million dollars".
- Percentages: "~50%" → "about 50 percent".
- Versions: "v1.2.3" → "version 1 point 2 point 3".
- Quarters: "Q4 2025" → "fourth quarter 2025".
- Abbreviations: "e.g." → "for example"; "i.e." → "that is"; "etc." → "etcetera".
- Read code identifiers naturally (split camelCase / snake_case into words).
- Expand units and symbols, but leave ordinary numbers for the speech engine.
- Do not change meaning; only rewrite how things are spoken.
```

## 4. Deterministic engine (M3)

A conservative, built-in set of regex transforms. **Key principle: expand
symbols / scales / abbreviations to words, but leave bare digit runs for Kokoro
to vocalize** (Kokoro already says "10 billion dollars" correctly). This avoids
shipping a number-to-words engine and avoids mangling.

Built-in transforms (applied in order, after user `replacements`):

| Input            | Output                          |
|------------------|---------------------------------|
| `$10B` / `$3.5M` | `10 billion dollars` / `3.5 million dollars` |
| `$10`            | `10 dollars`                    |
| `~50%` / `50%`   | `about 50 percent` / `50 percent` |
| `345k–400k`      | `345 thousand to 400 thousand`  |
| `v1.2.3`         | `version 1 point 2 point 3`     |
| `Q4 2025`        | `fourth quarter 2025`           |
| `e.g. i.e. etc. vs. Dr. Mr. Mrs.` | spoken forms       |
| `&` / `@`        | `and` / `at`                    |

Conservative on purpose (e.g. ambiguous `St.`, `#`, `/` are left alone). The LLM
mode handles the long tail. The deterministic engine is **always** the fallback
for `ai`.

## 5. LLM backend (M4)

### 5.1 Contract
`normalize()` builds one prompt and expects **only** the rewritten text back:

```
You rewrite text so it sounds correct read aloud by a text-to-speech engine.
Apply the rules. Output ONLY the rewritten text — no preamble, quotes, markdown,
or explanation. Preserve meaning and wording except where a rule applies. If
nothing needs changing, return the text unchanged.

Rules:
<kokoroSpeak.normalization.rules>

Text:
<input>
```

Output is trimmed and stripped of accidental code-fence/quote wrapping.

### 5.2 Backends (`backend`)
- `auto` (default): detect a CLI on PATH in order **`claude` → `codex`**; if none
  and no API key, fall back to deterministic.
- `cli`: use `kokoroSpeak.normalization.command` (e.g. `claude`, `codex`).
  - Claude: `claude -p "<prompt>" --output-format json` (parse `.result`),
    tools disabled, run in an empty temp cwd so it can't read the workspace.
  - Codex: `codex exec "<prompt>"` in a read-only/no-tool sandbox.
- `api`: Claude Messages API, key from SecretStorage, model = `…model`.

### 5.3 Gate (skip work)
Before any LLM call, a cheap regex checks for candidates (digits, `$ % @ & #`,
known abbreviations, `vN.N`, mixed-case identifiers). **No candidates → skip the
LLM and return the deterministic result** (usually unchanged). Most prose skips
the model entirely.

### 5.4 Cache
In-memory `Map` keyed by `sha256(mode + backendId + rulesHash + text)`, capped
(~500 entries, FIFO). Re-speaking identical text never re-calls the model.

### 5.5 Failure & privacy
- **Order in `ai` mode:** user `replacements` → gate → (cache hit?) → LLM with
  `timeoutMs` → on any failure (no backend, timeout, error, empty) → deterministic.
- **First `ai` use:** one-time modal — "Kokoro Speak will send the text you speak
  to <backend> to normalize it. Continue?" Choice remembered; decline → revert to
  `deterministic`.
- Only the text to speak is sent — never file paths or workspace metadata. The
  CLI runs with tools/file access off (§5.2).

### 5.6 Hot-path latency (known cost)
A CLI cold start can be ~1–3 s, added once per uncached speak in `ai` mode (whole
text = one call, not per sentence). Mitigated by the gate + cache, and avoided
entirely in the default `deterministic` mode. **Future:** keep a warm CLI process
(stdin streaming) — deferred; noted, not in this cut.

## 6. File layout

| File                         | Adds                                            |
|------------------------------|-------------------------------------------------|
| `src/normalize.ts`           | `normalize()`, deterministic engine, gate, cache, backends |
| `src/extension.ts`           | call `normalize()` between `getSpeakableText` and `synthesize`; "Set API Key" command; first-use opt-in |
| `package.json`               | the `kokoroSpeak.normalization.*` settings + command |
| `test/normalize.test.mjs`    | deterministic cases ($/%/version/abbr), gate, cache, fallback (no network) |

## 7. Rollout

1. **M3** — `src/normalize.ts` deterministic engine + `replacements` + gate +
   the settings, wired into `speak()`. Unit tests. Fully offline/customizable.
2. **M4** — add `ai` mode: backends (auto/cli/api), prompt, cache, timeout,
   deterministic fallback, first-use opt-in, Set-API-Key command.

## 8. Decisions for review

- **A. Default mode** = `deterministic` (offline, private, zero-setup); `ai` is
  opt-in. OK, or default to `ai`?
- **B. Rules split** = built-in deterministic transforms (fixed) + user
  `replacements` (custom, offline) + NL `rules` (custom, drives the LLM). OK?
- **C. Numbers** = expand symbols/scales/abbreviations, **leave bare digits to
  Kokoro** (no number-to-words engine). OK?
- **D. CLI default order** = `claude` → `codex`, one-shot calls + cache now,
  warm-process later. OK?
- **E. Whole-text** normalization (one call, may delay first audio in `ai`) vs.
  per-sentence pipelined (lower first-audio latency, more calls, less context).
  Proposed: whole-text. OK?
