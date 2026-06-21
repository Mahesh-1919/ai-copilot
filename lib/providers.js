// Provider adapters for chat-completion LLMs (text and vision).
// Each provider exposes:
//   - streamChat(messages, opts)         async generator yielding text deltas
//   - streamChatVision(messages, opts)   same, but messages may contain images
// `messages` for streamChatVision uses a multipart structure on user/assistant
// messages: { role, content: [{type:"text", text}, {type:"image", dataUrl}] }.

const SSE_LINE = /^data:\s*(.*)$/;

// Custom error class so callers can branch on HTTP status (esp. 429 quota,
// 5xx outages, network errors) and decide whether to fall back.
export class LLMHttpError extends Error {
  constructor({ status, provider, model, body, retryAfterHeader }) {
    super(`${provider} HTTP ${status}: ${(body || "").slice(0, 300)}`);
    this.name = "LLMHttpError";
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.body = body || "";
    this.retryAfterHeader = retryAfterHeader || "";
  }
  // Treat 429, 408, 5xx and 'network' (status=0) as retryable.
  isRetryable() {
    if (this.status === 429 || this.status === 408) return true;
    if (this.status >= 500 && this.status < 600) return true;
    if (this.status === 0) return true;
    return false;
  }
  // Permanent auth failures - no point retrying THIS key. Caller should mark
  // the key dead instead of cooling.
  isAuthFailure() {
    if (this.status === 401 || this.status === 403) return true;
    return false;
  }
}

// Best-effort: extract a Retry-After hint (in milliseconds) out of an
// LLMHttpError so the cooldown period reflects what the provider actually
// asked for. Falls back to null when nothing usable is found.
export function parseRetryAfterMs(err) {
  if (!err) return null;
  // 1) Native HTTP header (string seconds OR HTTP-date).
  const h = err.retryAfterHeader || "";
  if (h) {
    const sec = parseInt(h, 10);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
    const t = Date.parse(h);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  }
  // 2) JSON body. OpenRouter, Groq, OpenAI all use slight variations:
  //    OpenRouter: error.metadata.retry_after_seconds | error.metadata.headers["Retry-After"]
  //    OpenAI:     error.retry_after | error.message contains "Please retry after Xs"
  //    Groq:       error.retry_after | similar message
  const body = err.body || "";
  if (body) {
    try {
      const j = JSON.parse(body);
      const meta = j?.error?.metadata || {};
      const ra = meta.retry_after_seconds ?? j?.error?.retry_after_seconds
              ?? j?.retry_after_seconds   ?? j?.retry_after
              ?? j?.error?.retry_after;
      if (typeof ra === "number" && ra >= 0) return Math.ceil(ra * 1000);
      const metaHdr = meta.headers?.["Retry-After"] ?? meta.headers?.["retry-after"];
      if (metaHdr) {
        const n = parseInt(metaHdr, 10);
        if (Number.isFinite(n) && n >= 0) return n * 1000;
      }
    } catch { /* not JSON */ }
    // 3) Plain-text "Please try again in 17.5s" fallback.
    const m = /(?:try again|retry).{0,40}?(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes)\b/i.exec(body);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (Number.isFinite(n) && n >= 0) {
        if (unit === "ms")                       return Math.ceil(n);
        if (unit.startsWith("m") && unit !== "ms") return Math.ceil(n * 60_000);
        return Math.ceil(n * 1000);
      }
    }
  }
  return null;
}

// ---------- KeyPool: tracks per-key health for a multi-key rotation ----------
//
// Keys are tried in user-defined order. When one returns 429, we mark it
// "cooling" until either Retry-After expires or `cooldownDefaultMs` passes.
// On 401/403 we mark it "dead" (manual reset required).
//
// `health` is a plain object reference passed in by the caller, so the
// background script can persist it through chrome.storage.session and SW
// restarts. Mutations happen in place; the caller should snapshot+save
// after any markCooling/markDead/reset call.

export function tagKey(k) {
  if (!k) return "";
  const s = String(k);
  return s.length <= 14 ? s : s.slice(0, 8) + "..." + s.slice(-4);
}

export class KeyPool {
  constructor({ keys, health, cooldownDefaultMs = 5 * 60 * 1000 }) {
    this.keys = (keys || []).filter(Boolean);
    this.health = health || {};
    this.cooldownDefaultMs = cooldownDefaultMs;
  }

  size() { return this.keys.length; }

  // Snapshot of available keys, in user-defined order, AT THIS MOMENT.
  // Cooldowns that have expired are cleaned out as we walk.
  availableKeys() {
    const now = Date.now();
    const out = [];
    for (const k of this.keys) {
      const tag = tagKey(k);
      const h = this.health[tag];
      if (!h) { out.push(k); continue; }
      if (h.dead) continue;
      if (h.until && h.until > now) continue;
      delete this.health[tag];
      out.push(k);
    }
    return out;
  }

  hasAvailable() { return this.availableKeys().length > 0; }

  markCooling(key, retryAfterMs, reason) {
    const ms = (retryAfterMs && retryAfterMs > 0) ? retryAfterMs : this.cooldownDefaultMs;
    this.health[tagKey(key)] = {
      until: Date.now() + ms,
      dead: false,
      lastError: (reason || "").slice(0, 200),
    };
  }

  markDead(key, reason) {
    this.health[tagKey(key)] = {
      until: null,
      dead: true,
      lastError: (reason || "").slice(0, 200),
    };
  }

  // Apply the right policy for this error. Returns true if the key was marked
  // (so the caller knows to skip it on the next attempt).
  applyError(key, err) {
    if (err instanceof LLMHttpError) {
      if (err.isAuthFailure()) {
        this.markDead(key, `HTTP ${err.status}: ${err.body.slice(0, 120)}`);
        return true;
      }
      if (err.isRetryable()) {
        const retry = parseRetryAfterMs(err);
        this.markCooling(key, retry, `HTTP ${err.status}`);
        return true;
      }
    }
    return false;
  }

  reset(key) {
    if (key) {
      delete this.health[tagKey(key)];
    } else {
      for (const k of Object.keys(this.health)) delete this.health[k];
    }
  }

  // Per-key snapshot for the Options UI.
  status() {
    const now = Date.now();
    return this.keys.map((k, i) => {
      const tag = tagKey(k);
      const h = this.health[tag];
      if (!h) return { index: i, tag, state: "active" };
      if (h.dead) return { index: i, tag, state: "dead", lastError: h.lastError };
      if (h.until && h.until > now) {
        return { index: i, tag, state: "cooling", until: h.until, remainingMs: h.until - now, lastError: h.lastError };
      }
      return { index: i, tag, state: "active" };
    });
  }
}

async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = line.match(SSE_LINE);
      if (m) yield m[1];
    }
  }
}

function toOpenAIMessages(messages) {
  // Pass-through unless a message has a non-string content (vision parts).
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const parts = (m.content || []).map((p) => {
      if (p.type === "text")  return { type: "text", text: p.text };
      if (p.type === "image") return { type: "image_url", image_url: { url: p.dataUrl, detail: "auto" } };
      return p;
    });
    return { role: m.role, content: parts };
  });
}

function toGeminiContents(messages) {
  // Gemini wants `{role, parts:[{text}|{inlineData:{mimeType,data}}]}` and
  // accepts only "user"/"model" roles. System messages are split out by the caller.
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else {
        for (const p of m.content || []) {
          if (p.type === "text")  parts.push({ text: p.text });
          if (p.type === "image") {
            const m2 = /^data:([^;]+);base64,(.+)$/.exec(p.dataUrl || "");
            if (m2) parts.push({ inlineData: { mimeType: m2[1], data: m2[2] } });
          }
        }
      }
      return { role, parts };
    });
}

// ---------- OpenAI-compatible (OpenAI, Groq, OpenRouter, Together, Fireworks, Ollama, ...) ----------

class OpenAICompatibleProvider {
  constructor({ apiKey, model, baseUrl, providerLabel = "LLM" }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.providerLabel = providerLabel;
  }

  // OpenRouter recommends sending HTTP-Referer + X-Title so the request is
  // attributable to the calling app. They feed these into their per-app
  // rate limiter, so SETTING them gives slightly more headroom on the free
  // tier than not. Anonymous calls get aggressive throttling.
  _extraHeaders() {
    if (!/openrouter\.ai/i.test(this.baseUrl)) return {};
    return {
      "HTTP-Referer": "https://github.com/the-j/adshield-lite",
      "X-Title":      "AdShield Lite",
    };
  }

  async *_stream(messages, { temperature = 0.3, maxTokens = 1024, signal, modelOverride } = {}) {
    const model = modelOverride || this.model;
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this._extraHeaders(),
        },
        body: JSON.stringify({
          model,
          messages: toOpenAIMessages(messages),
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new LLMHttpError({ status: 0, provider: this.providerLabel, model, body: String(e?.message || e) });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMHttpError({
        status: res.status,
        provider: this.providerLabel,
        model,
        body: text,
        retryAfterHeader: res.headers.get("Retry-After") || "",
      });
    }
    for await (const data of sseLines(res)) {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch { /* ignore */ }
    }
  }

  async *streamChat(messages, opts = {})       { yield* this._stream(messages, opts); }
  async *streamChatVision(messages, opts = {}) { yield* this._stream(messages, opts); }
}

// ---------- Gemini ----------

class GeminiProvider {
  constructor({ apiKey, model, baseUrl, providerLabel = "Gemini" }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.providerLabel = providerLabel;
  }

  async *_stream(messages, { temperature = 0.3, maxTokens = 1024, signal, modelOverride } = {}) {
    const systemParts = messages.filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("\n")))
      .join("\n\n");
    const contents = toGeminiContents(messages);
    const model = modelOverride || this.model;
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens },
      ...(systemParts ? { systemInstruction: { parts: [{ text: systemParts }] } } : {}),
    };
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new LLMHttpError({ status: 0, provider: this.providerLabel, model, body: String(e?.message || e) });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMHttpError({
        status: res.status,
        provider: this.providerLabel,
        model,
        body: text,
        retryAfterHeader: res.headers.get("Retry-After") || "",
      });
    }
    for await (const data of sseLines(res)) {
      try {
        const json = JSON.parse(data);
        const parts = json.candidates?.[0]?.content?.parts || [];
        for (const p of parts) if (p.text) yield p.text;
      } catch { /* ignore */ }
    }
  }

  async *streamChat(messages, opts = {})       { yield* this._stream(messages, opts); }
  async *streamChatVision(messages, opts = {}) { yield* this._stream(messages, opts); }
}

// ---------- Public factory ----------

export const PROVIDER_PRESETS = {
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "moonshotai/kimi-k2-instruct",
      "qwen/qwen3-32b",
    ],
    visionModels: [
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "meta-llama/llama-4-maverick-17b-128e-instruct",
    ],
    sttModels: ["whisper-large-v3-turbo", "whisper-large-v3"],
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "o4-mini"],
    visionModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1"],
    sttModels: ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models:       ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    visionModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    sttModels: [],
  },
  openrouter: {
    label: "OpenRouter (free models available)",
    baseUrl: "https://openrouter.ai/api/v1",
    // OpenRouter rotates which models are offered on the :free tier - any
    // hard-coded list goes stale within weeks. The Options UI calls
    // fetchOpenRouterFreeModels() to refresh this dynamically; the static
    // list below is just a sensible default for first-time setup. List
    // verified live against /api/v1/models and ordered by usefulness for
    // an interview copilot (coding-strong + large-context first).
    models: [
      "qwen/qwen3-coder:free",
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "openai/gpt-oss-120b:free",
      "openai/gpt-oss-20b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-nano-9b-v2:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "nousresearch/hermes-3-llama-3.1-405b:free",
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
    ],
    visionModels: [
      "nvidia/nemotron-nano-12b-v2-vl:free",
    ],
    sttModels: [],
  },
  "openai-compatible": {
    label: "Custom OpenAI-compatible",
    baseUrl: "",
    models: [],
    visionModels: [],
    sttModels: [],
  },
};

function defaultVisionModel(cfg) {
  const preset = PROVIDER_PRESETS[cfg.provider];
  return cfg.visionModel?.trim()
      || preset?.visionModels?.[0]
      || cfg.model;
}

export function makeChatProvider(cfg) {
  const preset = PROVIDER_PRESETS[cfg.provider] || PROVIDER_PRESETS["openai-compatible"];
  const baseUrl = cfg.baseUrl?.trim() || preset.baseUrl;
  const label = preset?.label || cfg.provider || "LLM";
  if (!cfg.apiKey) throw new Error("No API key configured. Open the extension Options page.");
  if (cfg.provider === "gemini") {
    return new GeminiProvider({ apiKey: cfg.apiKey, model: cfg.model, baseUrl, providerLabel: label });
  }
  // Groq, OpenAI, OpenRouter and arbitrary "openai-compatible" all speak the
  // OpenAI Chat Completions wire format.
  if (!baseUrl) throw new Error("No baseUrl set for the custom provider.");
  return new OpenAICompatibleProvider({ apiKey: cfg.apiKey, model: cfg.model, baseUrl, providerLabel: label });
}

// Build a "fallback view" of the config for makeChatProvider.
// Returns null when no usable fallback is configured (no provider or no API key).
export function fallbackConfig(cfg) {
  if (!cfg?.fallbackEnabled) return null;
  const provider = cfg.fallbackProvider;
  if (!provider) return null;
  const apiKey = (cfg.fallbackApiKey || "").trim();
  if (!apiKey) return null;
  const preset  = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS["openai-compatible"];
  const baseUrl = (cfg.fallbackBaseUrl || "").trim() || preset.baseUrl;
  const model   = (cfg.fallbackModel   || "").trim() || preset.models?.[0] || cfg.model;
  return { provider, apiKey, baseUrl, model, visionModel: cfg.fallbackVisionModel || "" };
}

export function fallbackVisionModel(fbCfg) {
  if (!fbCfg) return null;
  const preset = PROVIDER_PRESETS[fbCfg.provider];
  return (fbCfg.visionModel || "").trim() || preset?.visionModels?.[0] || fbCfg.model;
}

// Expand a single fallback config into an ORDERED chain of cfg objects to
// try in sequence. For OpenRouter we tack the remaining free-tier models
// from the preset onto the end - so when the user-picked fallback 429s
// (which happens often on the free tier because some upstream providers
// throttle aggressively), we automatically try the next-best free model
// before giving up. Other providers just return [fbCfg] unchanged.
export function expandFallbackChain(fbCfg, { maxChat = 4, maxVision = 3 } = {}) {
  if (!fbCfg) return [];
  const chain = [fbCfg];
  if (fbCfg.provider !== "openrouter") return chain;

  const preset = PROVIDER_PRESETS.openrouter;
  if (!preset) return chain;

  for (const model of preset.models || []) {
    if (chain.length >= maxChat) break;
    if (chain.some((c) => c.model === model)) continue;
    chain.push({ ...fbCfg, model });
  }

  // Vision chain is shorter because there are far fewer vision-capable
  // free models. We rebuild it as a sibling array on each entry so the
  // caller can pick visionModel per attempt.
  const visionChain = [];
  if ((fbCfg.visionModel || "").trim()) visionChain.push(fbCfg.visionModel.trim());
  for (const vm of preset.visionModels || []) {
    if (visionChain.length >= maxVision) break;
    if (!visionChain.includes(vm)) visionChain.push(vm);
  }
  for (const c of chain) c._visionChain = visionChain;

  return chain;
}

export function getVisionModelOverride(cfg) {
  return defaultVisionModel(cfg);
}

export async function pingProvider(cfg) {
  const p = makeChatProvider(cfg);
  let out = "";
  for await (const delta of p.streamChat(
    [
      { role: "system", content: "Reply with exactly one word: pong" },
      { role: "user", content: "ping" },
    ],
    { maxTokens: 16, temperature: 0 },
  )) {
    out += delta;
    if (out.length > 50) break;
  }
  return out.trim();
}

// Query OpenRouter's public /models endpoint (no auth required) and return
// the IDs of models currently routed to the :free tier. Used by the Options
// page to keep the fallback model picker in sync with whatever OpenRouter
// is actually serving today.
export async function fetchOpenRouterFreeModels() {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter /models HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const all = Array.isArray(json?.data) ? json.data : [];

  const isFree = (m) => {
    const id  = String(m.id || "");
    const p   = m.pricing || {};
    const num = (v) => (v === undefined || v === null ? Infinity : Number(v));
    // Either an ":free" id, or both prompt+completion priced at 0.
    return id.endsWith(":free")
        || (num(p.prompt) === 0 && num(p.completion) === 0);
  };

  const visionCapable = (m) => {
    const mods = m.architecture?.input_modalities;
    if (Array.isArray(mods)) return mods.includes("image");
    // Fallback heuristic - a few model ids are known vision-capable.
    return /\b(vision|vl|llava|gemini)\b/i.test(String(m.id || ""));
  };

  const free = all.filter(isFree);
  return {
    models:       free.map((m) => m.id).sort(),
    visionModels: free.filter(visionCapable).map((m) => m.id).sort(),
  };
}
