// Options page. Every change saves immediately.

import Anthropic from "@anthropic-ai/sdk";
import { buildSystem, Replacement, SEED_RULES, stripWrapping } from "../../src/core/normalize";
import { loadApiKey, loadSettings, saveApiKey, saveSettings, Settings, voiceGroups, voiceLabel } from "./settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let savedTimer: ReturnType<typeof setTimeout> | undefined;
async function save(patch: Partial<Settings>) {
  const saved = $("saved");
  try {
    await saveSettings(patch);
    saved.textContent = "Saved";
    saved.classList.remove("error");
  } catch (e) {
    saved.textContent = `Not saved: ${(e as Error).message}`;
    saved.classList.add("error");
  }
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.textContent = ""), 2000);
}

function renderReplacements(list: Replacement[]) {
  const table = $<HTMLTableElement>("replacements");
  table.replaceChildren();
  const commit = () => {
    const rows = [...table.querySelectorAll("tr")].map((tr) => {
      const [from, to] = [...tr.querySelectorAll("input")].map((i) => i.value);
      return { from, to };
    });
    void save({ replacements: rows.filter((r) => r.from) });
  };
  for (const r of list) {
    const tr = table.insertRow();
    const from = Object.assign(document.createElement("input"), { type: "text", value: r.from ?? r.pattern ?? "", placeholder: "K8s", spellcheck: false });
    const to = Object.assign(document.createElement("input"), { type: "text", value: r.to ?? r.replacement ?? "", placeholder: "Kubernetes", spellcheck: false });
    from.setAttribute("aria-label", "Text");
    to.setAttribute("aria-label", "Say it as");
    from.onchange = to.onchange = commit;
    const del = Object.assign(document.createElement("button"), { type: "button", textContent: "Remove" });
    del.onclick = () => {
      tr.remove();
      commit();
    };
    tr.insertCell().append(from);
    tr.insertCell().append(to);
    tr.insertCell().append(del);
  }
}

async function testAi() {
  const out = $("test-result");
  out.hidden = false;
  out.classList.remove("error");
  const key = $<HTMLInputElement>("apiKey").value.trim();
  if (!key) {
    out.textContent = "Enter an API key first.";
    out.classList.add("error");
    return;
  }
  out.textContent = "Asking Claude…";
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 20000 });
  try {
    const res = await client.messages.create({
      model: $<HTMLInputElement>("model").value.trim(),
      max_tokens: 256,
      system: buildSystem($<HTMLTextAreaElement>("rules").value),
      messages: [{ role: "user", content: "Text to rewrite:\nRevenue hit $3.5M in Q4 2025, up ~20%." }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    out.textContent = `It works. Claude says: ${stripWrapping(text)}`;
  } catch (e) {
    out.classList.add("error");
    if (e instanceof Anthropic.AuthenticationError) out.textContent = "Anthropic rejected this API key.";
    else if (e instanceof Anthropic.NotFoundError) out.textContent = "Anthropic doesn't recognize that model name.";
    else if (e instanceof Anthropic.RateLimitError) out.textContent = "Rate limited; try again in a moment.";
    else if (e instanceof Anthropic.APIError && e.status) out.textContent = `Anthropic returned an error (${e.status}): ${e.message}`;
    else out.textContent = `Couldn't reach Anthropic: ${(e as Error).message}`;
  }
}

async function init() {
  const s = await loadSettings();

  const voice = $<HTMLSelectElement>("voice");
  for (const [group, voices] of voiceGroups()) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const v of voices) og.append(new Option(voiceLabel(v).split(" — ")[0], v));
    voice.append(og);
  }
  voice.value = s.voice;
  voice.onchange = () => save({ voice: voice.value as any });

  const speed = $<HTMLInputElement>("speed");
  const showSpeed = () => ($("speed-out").textContent = `${Number(speed.value).toFixed(2).replace(/0$/, "")}×`);
  speed.value = String(s.speed);
  showSpeed();
  speed.oninput = showSpeed;
  speed.onchange = () => save({ speed: Number(speed.value) });

  const device = $<HTMLSelectElement>("device");
  device.value = s.device;
  device.onchange = () => save({ device: device.value as Settings["device"] });

  for (const k of ["highlight", "autoScroll"] as const) {
    const box = $<HTMLInputElement>(k);
    box.checked = s[k];
    box.onchange = () => save({ [k]: box.checked });
  }

  const aiSection = $("ai-section");
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="normMode"]')) {
    radio.checked = radio.value === s.normMode;
    radio.onchange = () => {
      aiSection.hidden = radio.value !== "ai";
      void save({ normMode: radio.value as Settings["normMode"] });
    };
  }
  aiSection.hidden = s.normMode !== "ai";

  renderReplacements(s.replacements);
  $("add-replacement").onclick = () => {
    const rows = [...$("replacements").querySelectorAll("tr")].map((tr) => {
      const [from, to] = [...tr.querySelectorAll("input")].map((i) => i.value);
      return { from, to };
    });
    renderReplacements([...rows, { from: "", to: "" }]);
    ([...$("replacements").querySelectorAll("input")].at(-2) as HTMLInputElement | undefined)?.focus();
  };

  const spell = $<HTMLInputElement>("spellOut");
  spell.value = s.spellOut.join(", ");
  spell.onchange = () => save({ spellOut: spell.value.split(",").map((a) => a.trim()).filter(Boolean) });

  const key = $<HTMLInputElement>("apiKey");
  key.value = await loadApiKey();
  key.onchange = async () => {
    await saveApiKey(key.value.trim());
    $("saved").textContent = "Saved";
  };
  const model = $<HTMLInputElement>("model");
  model.value = s.model;
  model.onchange = () => save({ model: model.value.trim() });
  const rules = $<HTMLTextAreaElement>("rules");
  rules.value = s.rules;
  rules.onchange = () => save({ rules: rules.value });
  $("reset-rules").onclick = (e) => {
    e.preventDefault();
    rules.value = SEED_RULES;
    void save({ rules: SEED_RULES });
  };
  $("test-ai").onclick = () => void testAi();

  const order = ["speak-selection", "read-page", "pause-resume", "stop"];
  const shortcuts = (await chrome.commands.getAll()).sort((a, b) => order.indexOf(a.name ?? "") - order.indexOf(b.name ?? ""));
  $("shortcuts").textContent =
    shortcuts
      .filter((c) => c.shortcut && c.description)
      .map((c) => `${c.shortcut} ${c.description!.toLowerCase()}`)
      .join(" · ") || "none set";
  $("edit-shortcuts").onclick = (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  };
}

void init();
