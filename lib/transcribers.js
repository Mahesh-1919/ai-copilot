// Speech-to-text adapters. Each takes a 16kHz mono WAV Blob and returns { text }.

import { PROVIDER_PRESETS } from "./providers.js";

async function whisperHTTP({ baseUrl, apiKey, model, language, wavBlob }) {
  const fd = new FormData();
  fd.append("file", wavBlob, "audio.wav");
  fd.append("model", model);
  if (language) fd.append("language", language);
  fd.append("response_format", "json");
  fd.append("temperature", "0");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`STT HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  return { text: (j.text || "").trim() };
}

export async function transcribe(cfg, wavBlob) {
  // Whisper falls back to the chat-provider key when sttApiKey is blank.
  // Use the FIRST primary key from the rotation pool (apiKeys[0]) so STT
  // works even after the user migrated to multi-key.
  const primaryFirst = (cfg.apiKeys && cfg.apiKeys[0]) || cfg.apiKey || "";
  if (cfg.sttProvider === "groq-whisper") {
    const apiKey = cfg.sttApiKey?.trim() || (cfg.provider === "groq" ? primaryFirst : "");
    if (!apiKey) throw new Error("Groq STT key missing — set it in Options.");
    return whisperHTTP({
      baseUrl: PROVIDER_PRESETS.groq.baseUrl,
      apiKey,
      model: cfg.sttModel || "whisper-large-v3-turbo",
      language: cfg.sttLanguage,
      wavBlob,
    });
  }
  if (cfg.sttProvider === "openai-whisper") {
    const apiKey = cfg.sttApiKey?.trim() || (cfg.provider === "openai" ? primaryFirst : "");
    if (!apiKey) throw new Error("OpenAI STT key missing — set it in Options.");
    return whisperHTTP({
      baseUrl: PROVIDER_PRESETS.openai.baseUrl,
      apiKey,
      model: cfg.sttModel || "whisper-1",
      language: cfg.sttLanguage,
      wavBlob,
    });
  }
  throw new Error(`Unknown sttProvider: ${cfg.sttProvider}`);
}
