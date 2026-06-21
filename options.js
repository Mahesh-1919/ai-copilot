import { getConfig, setConfig, resetConfig, DEFAULTS } from "./lib/storage.js";
import { PROVIDER_PRESETS, pingProvider, fetchOpenRouterFreeModels } from "./lib/providers.js";
import { pingAssemblyAI } from "./lib/aaiStreaming.js";

// In-memory cache of OpenRouter's live free-model list. We refresh on
// demand from the Options UI - the static PROVIDER_PRESETS list is just a
// first-load default, since OpenRouter rotates which models are :free.
let openRouterFreeCache = null;

const el = (id) => document.getElementById(id);

// Note: "apiKey" is intentionally NOT in this list. The primary key is now
// managed as a multi-key list (apiKeys[]) by the rendering logic below.
const fields = [
  "provider", "model", "visionModel", "baseUrl",
  "fallbackEnabled", "fallbackProvider", "fallbackModel",
  "fallbackVisionModel", "fallbackApiKey", "fallbackBaseUrl",
  "sttProvider", "sttModel", "sttLanguage", "sttApiKey",
  "keytermsPrompt",
  "aaiInterruptionDelay", "aaiMinTurnSilence", "aaiMaxTurnSilence",
  "systemPrompt", "resume", "jobDescription",
  "autoAnswer", "autoPopOut",
  "autoAnswerDebounceMs", "autoAnswerDebounceIncompleteMs",
  "silenceMs", "maxChunkMs", "minChunkMs", "silenceRms",
];

// ----- Multi-key API list -----
//
// Source of truth while the page is open is the DOM under #apiKeysList.
// On save we collect the trimmed, deduped values back into cfg.apiKeys
// (and also write legacy apiKey="" so the old field doesn't shadow them).

function renderKeyRows(keys) {
  const list = el("apiKeysList");
  list.innerHTML = "";
  const arr = (keys && keys.length) ? keys : [""];
  arr.forEach((k, i) => list.appendChild(buildKeyRow(k, i)));
  refreshKeyStatuses();
}

function buildKeyRow(key, i) {
  const row = document.createElement("div");
  row.className = "key-row";
  row.dataset.idx = String(i);

  const idx = document.createElement("span");
  idx.className = "key-idx";
  idx.textContent = `#${i + 1}`;

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "sk-... / gsk_... / sk-or-... / AIza...";
  input.value = key || "";
  input.addEventListener("input", refreshRowIndices);

  const badge = document.createElement("span");
  badge.className = "key-status empty";
  badge.textContent = key ? "—" : "empty";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.title = "Remove this key";
  del.textContent = "Remove";
  del.addEventListener("click", () => {
    row.remove();
    if (!el("apiKeysList").children.length) {
      el("apiKeysList").appendChild(buildKeyRow("", 0));
    }
    refreshRowIndices();
    refreshKeyStatuses();
  });

  row.append(idx, input, badge, del);
  return row;
}

function refreshRowIndices() {
  const rows = [...el("apiKeysList").querySelectorAll(".key-row")];
  rows.forEach((r, i) => {
    r.dataset.idx = String(i);
    r.querySelector(".key-idx").textContent = `#${i + 1}`;
    const badge = r.querySelector(".key-status");
    const input = r.querySelector("input");
    if (!input.value.trim()) {
      badge.className = "key-status empty";
      badge.textContent = "empty";
    }
  });
}

function readKeysFromUI() {
  const inputs = [...el("apiKeysList").querySelectorAll(".key-row input")];
  const seen = new Set();
  const out = [];
  for (const inp of inputs) {
    const v = (inp.value || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function fmtCooldown(ms) {
  if (ms <= 0) return "ready";
  if (ms < 60_000)        return `${Math.ceil(ms / 1000)}s`;
  if (ms < 60 * 60_000)   return `${Math.floor(ms / 60_000)}m ${Math.ceil((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / (60 * 60_000))}h`;
}

async function refreshKeyStatuses() {
  // Health is keyed by tag (first 8 + last 4 chars of the key) on the
  // background side. We reproduce the same hash here and look up each row.
  const keys = readKeysFromUI();
  let status = [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: "get-key-health" });
    if (resp?.status) status = resp.status;
  } catch { /* SW may be cold; fine to skip */ }
  const byTag = new Map(status.map((s) => [s.tag, s]));

  const rows = [...el("apiKeysList").querySelectorAll(".key-row")];
  rows.forEach((row) => {
    const input = row.querySelector("input");
    const badge = row.querySelector(".key-status");
    const v = (input.value || "").trim();
    if (!v) {
      badge.className = "key-status empty";
      badge.textContent = "empty";
      return;
    }
    const tag = v.length <= 14 ? v : v.slice(0, 8) + "..." + v.slice(-4);
    const s = byTag.get(tag);
    if (!s || s.state === "active") {
      badge.className = "key-status active";
      badge.textContent = "active";
    } else if (s.state === "cooling") {
      badge.className = "key-status cooling";
      badge.textContent = `cooling ${fmtCooldown(s.remainingMs)}`;
      badge.title = s.lastError || "";
    } else if (s.state === "dead") {
      badge.className = "key-status dead";
      badge.textContent = "dead";
      badge.title = s.lastError || "auth failed";
    }
  });
}

const STT_DEFAULT_MODELS = {
  "assemblyai":     "u3-rt-pro",
  "groq-whisper":   "whisper-large-v3-turbo",
  "openai-whisper": "whisper-1",
};

function fillDatalist(id, items) {
  const dl = el(id);
  if (!dl) return;
  dl.innerHTML = "";
  (items || []).forEach((m) => {
    const o = document.createElement("option");
    o.value = m;
    dl.appendChild(o);
  });
}

function refreshModelHints() {
  const provider = el("provider").value;
  const preset = PROVIDER_PRESETS[provider];
  fillDatalist("model-list",        preset?.models);
  fillDatalist("vision-model-list", preset?.visionModels);
  el("baseUrl-row").style.display = provider === "openai-compatible" ? "" : "none";
}

function refreshFallbackHints() {
  const provider = el("fallbackProvider").value;
  const preset = PROVIDER_PRESETS[provider];
  // If OpenRouter and we have a fresh live list cached, prefer it over the
  // static (potentially-stale) curated default.
  if (provider === "openrouter" && openRouterFreeCache) {
    fillDatalist("fallback-model-list",  openRouterFreeCache.models);
    fillDatalist("fallback-vision-list", openRouterFreeCache.visionModels);
  } else {
    fillDatalist("fallback-model-list",  preset?.models);
    fillDatalist("fallback-vision-list", preset?.visionModels);
  }
  el("fallbackBaseUrl-row").style.display = provider === "openai-compatible" ? "" : "none";

  const refreshBtn = el("refreshFallbackModels");
  if (refreshBtn) refreshBtn.style.display = provider === "openrouter" ? "" : "none";
}

async function refreshOpenRouterModels() {
  flash("refreshFallbackResult", "Fetching from openrouter.ai...");
  try {
    const lists = await fetchOpenRouterFreeModels();
    openRouterFreeCache = lists;
    fillDatalist("fallback-model-list",  lists.models);
    fillDatalist("fallback-vision-list", lists.visionModels);
    flash("refreshFallbackResult", `OK - ${lists.models.length} free models, ${lists.visionModels.length} with vision.`, "ok");
  } catch (e) {
    flash("refreshFallbackResult", `Failed: ${e.message || e}`, "err");
  }
}

function refreshSttUI() {
  const stt = el("sttProvider").value;
  const isAai = stt === "assemblyai";
  document.querySelectorAll(".aai-only").forEach((n) => {
    n.style.display = isAai ? "" : "none";
  });
  document.querySelectorAll(".whisper-only").forEach((n) => {
    n.style.display = isAai ? "none" : "";
  });
}

async function load() {
  const cfg = await getConfig();
  for (const f of fields) {
    const node = el(f);
    if (!node) continue;
    if (node.type === "checkbox") node.checked = !!cfg[f];
    else node.value = cfg[f] ?? "";
  }
  renderKeyRows(cfg.apiKeys);
  refreshModelHints();
  refreshFallbackHints();
  refreshSttUI();

  // If the user has OpenRouter as a fallback, kick off a background refresh
  // so the model dropdown reflects what's actually available right now.
  if (cfg.fallbackProvider === "openrouter") {
    refreshOpenRouterModels().catch(() => { /* best effort, silent */ });
  }
}

async function save() {
  const patch = {};
  for (const f of fields) {
    const node = el(f);
    if (!node) continue;
    if (node.type === "checkbox") patch[f] = node.checked;
    else if (node.type === "number") patch[f] = Number(node.value);
    else patch[f] = node.value;
  }
  // Persist the multi-key list. We also blank out the legacy single-key
  // field so it doesn't shadow the new pool on later loads.
  patch.apiKeys = readKeysFromUI();
  patch.apiKey  = "";
  await setConfig(patch);
  flash("saveResult", "Saved", "ok");
  refreshKeyStatuses();
}

function flash(id, text, kind = "") {
  const n = el(id);
  n.textContent = text;
  n.className = "testResult " + kind;
  setTimeout(() => {
    n.textContent = "";
    n.className = "testResult";
  }, 3500);
}

el("provider").addEventListener("change", () => {
  refreshModelHints();
  const provider = el("provider").value;
  const preset = PROVIDER_PRESETS[provider];
  if (preset?.models?.length && !el("model").value) {
    el("model").value = preset.models[0];
  }
});

el("fallbackProvider").addEventListener("change", () => {
  refreshFallbackHints();
  const provider = el("fallbackProvider").value;
  const preset = PROVIDER_PRESETS[provider];
  if (preset?.models?.length) {
    el("fallbackModel").value = preset.models[0];
  } else {
    el("fallbackModel").value = "";
  }
  if (provider === "openrouter") {
    refreshOpenRouterModels().catch(() => {});
  }
});

el("refreshFallbackModels").addEventListener("click", () => {
  refreshOpenRouterModels();
});

el("sttProvider").addEventListener("change", () => {
  refreshSttUI();
  const sttDefault = STT_DEFAULT_MODELS[el("sttProvider").value];
  if (sttDefault && !el("sttModel").value) {
    el("sttModel").value = sttDefault;
  }
});

el("test").addEventListener("click", async () => {
  flash("testResult", "Testing...");
  try {
    await save();
    const cfg = await getConfig();
    if (!cfg.apiKeys.length) throw new Error("Add at least one API key first.");
    // Use the first key for the test - that's the one the extension will
    // use first at runtime. If it's failing, the user wants to know now.
    const testCfg = { ...cfg, apiKey: cfg.apiKeys[0] };
    const txt = await pingProvider(testCfg);
    flash("testResult", `OK - key #1 replied: "${txt}"`, "ok");
  } catch (e) {
    flash("testResult", `Failed: ${e.message || e}`, "err");
  }
});

el("addApiKey").addEventListener("click", () => {
  const list = el("apiKeysList");
  list.appendChild(buildKeyRow("", list.children.length));
  refreshRowIndices();
});

el("resetKeyHealth").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "reset-key-health" });
    flash("keyHealthResult", "Cooldowns cleared - all keys active again.", "ok");
    refreshKeyStatuses();
  } catch (e) {
    flash("keyHealthResult", `Failed: ${e?.message || e}`, "err");
  }
});

// Helper for the resume/JD reload buttons - both have the same shape:
// send a message, on success update the textarea contents AND show the
// new length so the user knows the sync actually pulled fresh data.
async function reloadDocFromFile({ msgType, fieldId, resultId, label }) {
  flash(resultId, `Reading ${label} file...`);
  try {
    const resp = await chrome.runtime.sendMessage({ type: msgType });
    if (!resp?.ok || !resp.summary) {
      flash(resultId, `No ${label} file found at the extension root.`, "err");
      return;
    }
    // The background already wrote the new value to chrome.storage; pull
    // it back out so the textarea reflects what's actually persisted.
    const cfg = await getConfig();
    const node = el(fieldId);
    if (node) node.value = cfg[fieldId] || "";
    const s = resp.summary;
    flash(resultId, `Loaded ${s.length.toLocaleString()} chars from ${s.source}.`, "ok");
  } catch (e) {
    flash(resultId, `Failed: ${e?.message || e}`, "err");
  }
}

el("reloadResumeFromFile").addEventListener("click", () => reloadDocFromFile({
  msgType: "reload-resume-from-file",
  fieldId: "resume",
  resultId: "resumeReloadResult",
  label: "resume",
}));

el("reloadJdFromFile").addEventListener("click", () => reloadDocFromFile({
  msgType: "reload-jd-from-file",
  fieldId: "jobDescription",
  resultId: "jdReloadResult",
  label: "JD",
}));

el("reloadKeysFromFile").addEventListener("click", async () => {
  flash("keyHealthResult", "Reading api-keys file...");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "reload-keys-from-file" });
    if (!resp?.ok) {
      flash("keyHealthResult", "No api-keys.{json,txt} found in the extension folder.", "err");
      return;
    }
    const s = resp.summary || {};
    const counts = s.counts || {};
    // Build a "Groq:5, OpenRouter:1, AssemblyAI:2" style summary so the
    // user can confirm at a glance that every key they expected was picked
    // up. We omit zero-count categories to keep the toast short.
    const parts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`);
    const tail = parts.length ? ` - ${parts.join(", ")}` : "";
    flash("keyHealthResult", `Loaded ${s.total || 0} key(s) from ${s.source}${tail}.`, "ok");
    // Re-render the key list so the user sees the new keys immediately
    // without a hard reload of the Options page.
    await load();
  } catch (e) {
    flash("keyHealthResult", `Failed: ${e?.message || e}`, "err");
  }
});

// Poll the background for live cooldown timers. Cheap message, tiny payload.
setInterval(refreshKeyStatuses, 5000);

el("testFallback").addEventListener("click", async () => {
  flash("fallbackTestResult", "Testing fallback...");
  try {
    await save();
    const cfg = await getConfig();
    const apiKey = (cfg.fallbackApiKey || "").trim();
    if (!apiKey) throw new Error("Paste a fallback API key first.");
    const preset = PROVIDER_PRESETS[cfg.fallbackProvider];
    const fbCfg = {
      provider: cfg.fallbackProvider,
      apiKey,
      model:   cfg.fallbackModel?.trim() || preset?.models?.[0],
      baseUrl: cfg.fallbackBaseUrl?.trim() || preset?.baseUrl || "",
    };
    const txt = await pingProvider(fbCfg);
    flash("fallbackTestResult", `OK - fallback replied: "${txt}"`, "ok");
  } catch (e) {
    flash("fallbackTestResult", `Failed: ${e.message || e}`, "err");
  }
});

el("testStt").addEventListener("click", async () => {
  flash("sttTestResult", "Testing...");
  try {
    await save();
    const cfg = await getConfig();
    if (cfg.sttProvider === "assemblyai") {
      const key = (cfg.sttApiKey || "").trim();
      if (!key) throw new Error("Paste your AssemblyAI key in the STT API key field.");
      const out = await pingAssemblyAI(key);
      flash("sttTestResult", `OK - ${out}`, "ok");
    } else {
      flash("sttTestResult", "Whisper keys are exercised on the first audio chunk - no separate test needed.", "");
    }
  } catch (e) {
    flash("sttTestResult", `Failed: ${e.message || e}`, "err");
  }
});

el("save").addEventListener("click", save);

el("reset").addEventListener("click", async () => {
  if (!confirm("Reset all settings (including your API keys) to defaults?")) return;
  await resetConfig();
  await load();
  flash("saveResult", "Reset to defaults", "ok");
});

load();
