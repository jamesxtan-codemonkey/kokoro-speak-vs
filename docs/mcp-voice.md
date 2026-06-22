# Voice for AI agents (MCP server)

`kokoro-speak-mcp` is a standalone [MCP](https://modelcontextprotocol.io) server
that lets an MCP-capable agent — **Claude Code**, the **Codex VS Code extension**,
Claude Desktop, etc. — speak text aloud on your machine. The agent can voice its
replies or join a spoken discussion by calling a tool.

It reuses the extension's vscode-free core (`src/speaker.ts` → synth +
PCM/`afplay` players) and runs as its own process, so it does **not** need VS
Code. It keeps the Kokoro model **warm** across calls for low latency, and loads
the model **bundled with the extension** — so it runs fully offline (set
`KOKORO_MODEL_PATH` to override the model folder).

The server **ships inside the installed extension** (`dist/mcp.js`), so you can
register it straight from the extension directory — no source checkout needed
(see [Register from an installed extension](#register-from-an-installed-extension)).

## Tools

| Tool | Args | What it does |
|---|---|---|
| `speak` | `text`, `voice?`, `speed?` | Speak `text` aloud; returns when audio finishes. A new call interrupts current speech. Markdown is stripped; numbers/symbols are normalized. |
| `stop` | — | Stop any current speech immediately. |
| `list_voices` | — | List the 28 voice ids (a=American/b=British, f=female/m=male). |

## Register from an installed extension

If you installed the **Kokoro Speak** extension (the VSIX — no source checkout),
the MCP server and its model are already on disk inside the extension folder.
Point your agent at that `dist/mcp.js`; the path includes the version, so find it
first:

```bash
# newest installed copy across VS Code / Cursor / Windsurf / Insiders / Remote
find ~/.vscode/extensions ~/.cursor/extensions ~/.windsurf/extensions \
  ~/.vscode-insiders/extensions ~/.vscode-server/extensions \
  -maxdepth 3 -path '*/jamestan.kokoro-speak-vs-*/dist/mcp.js' 2>/dev/null | sort -V | tail -1
```

Use the path it prints in the register steps below (it ends in
`…/jamestan.kokoro-speak-vs-<version>/dist/mcp.js`). No build step is needed — the
server loads the bundled model and runs offline.

> **Asking an agent to enable it:** point it at
> [MCP-FOR-AGENTS.md](../MCP-FOR-AGENTS.md) (a self-contained recipe, also shipped
> inside the extension), or just say *"install the Kokoro Speak MCP server."* The
> only requirement is a `node` binary on `PATH`.

## Build it (from source)

For development from the repo:

```bash
npm install
npm run build:mcp        # → dist/mcp.js (executable, runs with node)
```

The absolute path you'll register is `<repo>/dist/mcp.js`, e.g.
`/Users/you/code/kokoro-speak-vs/dist/mcp.js`.

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
  for local agents (Claude Code / Codex on your Mac). A cloud agent has no
  speakers.
- **Offline.** The model is bundled (in the installed extension, or `model/` when
  run from source), so nothing is downloaded at runtime. Set `KOKORO_MODEL_PATH`
  to point at a different model folder.
- **Needs `node` on `PATH`** — the agent launches the server with `node`.
- **macOS** uses native PCM streaming (audify → CoreAudio): exact pause-free
  playback, instant interrupt. Other platforms fall back to the OS CLI player.
- `speak` **blocks until the audio finishes** — keep spoken text short; don't
  queue many long calls. Call `speak` again to interrupt.
- stdout is the MCP JSON-RPC channel; the server routes all library logging to
  stderr so it can't corrupt the protocol.
