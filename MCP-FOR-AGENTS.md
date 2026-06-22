# Install Kokoro Speak's MCP server (instructions for an AI agent)

**If a user asks you (an AI coding agent) to "install / set up / enable the Kokoro
Speak MCP server" — follow these steps verbatim.** They register a local MCP
server that gives you a `speak` tool (neural text-to-speech on the user's
machine). It runs **offline** (the model is bundled) and needs only a `node`
binary on `PATH`.

## Step 1 — Locate the server (`dist/mcp.js`)

The server ships inside the installed VS Code extension. Find the newest copy
(covers VS Code, Cursor, Windsurf, Insiders, and Remote/SSH; works in bash and
zsh):

```bash
find \
  ~/.vscode/extensions ~/.cursor/extensions ~/.windsurf/extensions \
  ~/.vscode-insiders/extensions ~/.vscode-server/extensions \
  -maxdepth 3 -path '*/jamestan.kokoro-speak-vs-*/dist/mcp.js' \
  2>/dev/null | sort -V | tail -1
```

- On **Windows (PowerShell)**:
  `Get-ChildItem "$env:USERPROFILE\.vscode\extensions\jamestan.kokoro-speak-vs-*\dist\mcp.js" | Sort-Object Name | Select-Object -Last 1`
- If nothing is found, the extension isn't installed — ask the user to install
  the **Kokoro Speak** VS Code extension first.
- If you're working **in the extension's source repo instead**, run
  `npm install && npm run build:mcp` and use `<repo>/dist/mcp.js`.

Save the printed absolute path; call it `<MCP_PATH>` below.

## Step 2 — Check the prerequisite

```bash
node --version   # any reasonably recent Node works; it just must exist on PATH
```

## Step 3 — Register it with the user's agent

Use the client the user actually runs (ask if unsure). Quote `<MCP_PATH>` in case
it contains spaces.

**Claude Code (CLI):**

```bash
claude mcp add kokoro-speak -- node "<MCP_PATH>"
```

**Claude Code / generic — project `.mcp.json`:**

```json
{
  "mcpServers": {
    "kokoro-speak": { "command": "node", "args": ["<MCP_PATH>"] }
  }
}
```

**Codex (`~/.codex/config.toml`):**

```toml
[mcp_servers.kokoro-speak]
command = "node"
args = ["<MCP_PATH>"]
```

**Claude Desktop (`claude_desktop_config.json`)** — same shape as `.mcp.json`
under `mcpServers`.

## Step 4 — Verify

Reload/restart the agent so it picks up the new server, then confirm the tools
`speak`, `stop`, and `list_voices` are available. Test with a short call, e.g.
speak *"Kokoro Speak is connected."* If the user wants you to speak replies
proactively, also load the [speak-aloud skill](skills/speak-aloud.md).

## Notes

- **Offline by default** — the model is bundled. To use a different model folder,
  set the env var `KOKORO_MODEL_PATH` on the server (e.g. add `"env": {
  "KOKORO_MODEL_PATH": "/path/to/model" }` to the JSON entry).
- **Local audio only** — audio plays on the machine running the server, so this
  is for local agents, not cloud ones.
- Full reference: [docs/mcp-voice.md](docs/mcp-voice.md).
