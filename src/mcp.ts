// Kokoro Speak MCP server (stdio). Lets an MCP-capable agent — Claude Code, the
// Codex VS Code extension, Claude Desktop, etc. — speak text aloud on the user's
// machine, so it can voice a reply or join a spoken discussion.
//
// Reuses the same vscode-free core as the extension (Speaker → synth + PCM/file
// players), and keeps the Kokoro model warm across calls for low latency.

// stdout is the MCP JSON-RPC channel — make sure nothing else writes to it.
// Kokoro/transformers/onnxruntime log via console.*, so route those to stderr.
for (const k of ["log", "info", "warn", "debug", "trace"] as const) {
  // eslint-disable-next-line no-console
  console[k] = (...args: unknown[]) =>
    process.stderr.write(args.map((a) => String(a)).join(" ") + "\n");
}

import * as path from "path";
import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Speaker } from "./speaker";
import { setModelSource } from "./synth";
import { VOICES, DEFAULT_VOICE, describeVoice } from "./voices";
// Single source of truth for the version (inlined from package.json at build).
import { version } from "../package.json";

/**
 * Where to load the Kokoro model from, so the server runs offline like the
 * extension. Priority: KOKORO_MODEL_PATH env → the model bundled next to this
 * script (dist/mcp.js → ../model) → undefined (download from HuggingFace).
 */
function resolveModelDir(): string | undefined {
  const env = process.env.KOKORO_MODEL_PATH?.trim();
  if (env) return env;
  const bundled = path.join(__dirname, "..", "model");
  return fs.existsSync(path.join(bundled, "config.json")) ? bundled : undefined;
}

setModelSource(resolveModelDir());

const speaker = new Speaker();

const server = new McpServer({ name: "kokoro-speak", version });

server.registerTool(
  "speak",
  {
    title: "Speak aloud",
    description:
      "Speak text aloud on the user's machine with the local Kokoro neural voice. " +
      "Use it to vocalize your reply or to join a spoken discussion. The call " +
      "returns once the audio finishes playing. Calling speak again interrupts any " +
      "speech still playing. Pass plain text or Markdown (Markdown is stripped).",
    inputSchema: {
      text: z.string().describe("The text to speak."),
      voice: z
        .enum(VOICES as unknown as [string, ...string[]])
        .optional()
        .describe(
          `Voice id (default ${DEFAULT_VOICE}). 1st letter a=American/b=British, 2nd f=female/m=male.`
        ),
      speed: z
        .number()
        .min(0.5)
        .max(2)
        .optional()
        .describe("Speaking rate multiplier, 0.5–2.0 (default 1)."),
    },
  },
  async ({ text, voice, speed }) => {
    try {
      const r = await speaker.speak(text, { voice, speed });
      return {
        content: [
          {
            type: "text",
            text: r.spoken
              ? `Spoke ${r.sentences} sentence(s).`
              : "Nothing to speak (empty text or interrupted).",
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Speak failed: ${e?.message ?? String(e)}` }],
      };
    }
  }
);

server.registerTool(
  "stop",
  {
    title: "Stop speaking",
    description: "Immediately stop any speech that is currently playing.",
    inputSchema: {},
  },
  async () => {
    speaker.stop();
    return { content: [{ type: "text", text: "Stopped." }] };
  }
);

server.registerTool(
  "list_voices",
  {
    title: "List voices",
    description: "List the available Kokoro voice ids and their accent/gender.",
    inputSchema: {},
  },
  async () => {
    const lines = VOICES.map((v) => `${v} — ${describeVoice(v)}`).join("\n");
    return { content: [{ type: "text", text: lines }] };
  }
);

async function main() {
  // Warm the model in the background; first speak() will await it if not ready.
  // (Skipped in tests, which only exercise the protocol/schemas.)
  if (!process.env.KOKORO_MCP_NO_WARM) speaker.warm().catch(() => {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(
    `kokoro-speak MCP failed to start: ${e?.stack ?? String(e)}\n`
  );
  process.exit(1);
});
