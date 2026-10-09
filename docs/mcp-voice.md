# Voice for AI agents (MCP server)

`kokoro-speak-mcp` is a standalone [MCP](https://modelcontextprotocol.io) server
that lets an MCP-capable agent — **Claude Code**, the **Codex VS Code extension**,
Claude Desktop, etc. — speak text aloud on your machine. The agent can voice its
replies or join a spoken discussion by calling a tool.

It reuses the extension's vscode-free core (`src/speaker.ts` → synth +
PCM/`afplay` players) and runs as its own process, so it does **not** need VS
Code. It keeps the Kokoro model **warm** across calls for low latency.

## Tools

| Tool | Args | What it does |
|---|---|---|
| `speak` | `text`, `voice?`, `speed?` | Speak `text` aloud; returns when audio finishes. A new call interrupts current speech. Markdown is stripped; numbers/symbols are normalized. |
| `stop` | — | Stop any current speech immediately. |
| `list_voices` | — | List the 28 voice ids (a=American/b=British, f=female/m=male). |

## Build it

```bash
npm install
npm run build:mcp        # → dist/mcp.js (executable, runs with node)
```

The absolute path you'll register is `<repo>/dist/mcp.js`, e.g.
`/Users/you/code/kokoro-speak-vs/dist/mcp.js` (Windows: `C:\code\kokoro-speak-vs\dist\mcp.js` —
use forward slashes or escaped backslashes inside JSON/TOML strings).

## Register it

### Claude Code

```bash
claude mcp add kokoro-speak -- node /ABS/PATH/kokoro-speak-vs/dist/mcp.js
```

or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "kokoro-speak": { "command": "node", "args": ["/ABS/PATH/kokoro-speak-vs/dist/mcp.js"] }
  }
}
```

### Codex (CLI / VS Code extension)

In `~/.codex/config.toml`:

```toml
[mcp_servers.kokoro-speak]
command = "node"
args = ["/ABS/PATH/kokoro-speak-vs/dist/mcp.js"]
```

After registering, the agent sees `speak` / `stop` / `list_voices`. Try: *"say
hello in a British male voice."*

## Make the agent speak its replies

Registering the server gives the agent the *ability* to speak; to make it speak
**proactively** (vocalize replies / join discussions), point it at the
[speak-aloud skill](../skills/speak-aloud.md) — add it to the agent's skills or
paste its guidance into your prompt/instructions.

## Notes & limits

- **Local audio only.** The server plays on whatever machine it runs on, so it's
  for local agents (Claude Code / Codex on your machine). A cloud agent has no
  speakers.
- **macOS and Windows** use native PCM streaming (audify → CoreAudio / WASAPI): exact pause-free
  playback, instant interrupt. Other platforms fall back to the OS CLI player.
- **GPU:** on Windows the server synthesizes on the GPU via DirectML (same
  `auto` logic as the extension, falling back to the CPU). Override with env
  vars in the server registration: `KOKORO_SPEAK_DEVICE` = `auto` | `gpu` | `cpu`
  and `KOKORO_SPEAK_PRECISION` = `auto` | `q8` | `fp16` | `fp32`.
- **Offline:** run `npm run fetch-model` once and the server uses the model in
  `<repo>/models` (the same one the VSIX bundles) instead of downloading it;
  `KOKORO_SPEAK_OFFLINE=1` forbids downloads entirely.
- `speak` **blocks until the audio finishes** — keep spoken text short; don't
  queue many long calls. Call `speak` again to interrupt.
- stdout is the MCP JSON-RPC channel; the server routes all library logging to
  stderr so it can't corrupt the protocol.
