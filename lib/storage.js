// Thin wrapper around chrome.storage.local with sane defaults.

export const DEFAULTS = {
  // LLM provider for chat completions (and screen analysis)
  provider: "groq",                 // "groq" | "openai" | "gemini" | "openrouter" | "openai-compatible"
  model: "llama-3.3-70b-versatile",
  visionModel: "",                  // optional - falls back to a sensible per-provider default
  apiKey: "",                       // legacy single-key field, kept for back-compat
  apiKeys: [],                      // multi-key rotation pool (preferred). When non-empty,
  // overrides apiKey. Keys are tried in order; on 429 the
  // current key is put on cooldown and the next key is used.
  keyCooldownDefaultMs: 5 * 60 * 1000, // 5 min default cooldown when 429 has no Retry-After
  baseUrl: "",                      // optional override (used by "openai-compatible")

  // Fallback LLM - used when the primary provider returns 429/5xx (e.g. Groq
  // free-tier daily quota exhausted). Defaults to OpenRouter's free Llama 3.3
  // 70B endpoint, which only requires a free OpenRouter API key.
  fallbackEnabled: true,
  fallbackProvider: "openrouter",
  fallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
  fallbackVisionModel: "",
  fallbackApiKey: "",
  fallbackBaseUrl: "",

  // Transcription
  sttProvider: "assemblyai",        // "assemblyai" | "groq-whisper" | "openai-whisper"
  sttApiKey: "",                    // optional - falls back to apiKey if same provider
  sttModel: "u3-rt-pro",
  sttLanguage: "en",                // ISO-639-1, "" for auto (silently ignored on AssemblyAI u3-rt-pro)

  // AssemblyAI streaming-only knobs
  aaiInterruptionDelay: 200,        // ms, 0..1000
  aaiMinTurnSilence: 100,           // ms - speculative end-of-turn check
  aaiMaxTurnSilence: 2000,          // ms - hard end-of-turn deadline. Was
  // 1000 originally; bumped to 2000 because
  // many speakers naturally pause ~1s
  // mid-question and 1000 was firing finals
  // before the question was complete.
  keytermsPrompt: "",               // comma- or newline-separated; up to 100 items, <=50 chars each

  // Whisper VAD chunker behavior (ignored when sttProvider is "assemblyai")
  autoAnswer: true,
  silenceMs: 1200,
  maxChunkMs: 15000,
  minChunkMs: 1200,
  silenceRms: 0.012,

  // Auto-answer debounce. After AssemblyAI emits an end-of-turn final
  // (or Whisper finishes a chunk) we wait this long before asking the
  // LLM, so two finals arriving back-to-back collapse into one answer.
  // The "incomplete" variant is used when the trailing text looks
  // mid-thought (trailing comma, connector word like "and"/"to", etc.)
  // - it gives the speaker more breathing room before we commit.
  autoAnswerDebounceMs: 1500,
  autoAnswerDebounceIncompleteMs: 2500,

  // Persona / grounding
  systemPrompt: defaultSystemPrompt(),
  resume: "",
  jobDescription: "",

  // UI
  fontSize: 15,
  theme: "dark",
  // Stealth: when true the in-tab panel is NEVER shown. On session start
  // only a tiny AS badge appears (and Ctrl+Shift+Y works as a hotkey). The
  // first click/keypress pops the panel into a Document PiP window so it
  // floats over any app and is invisible during "share a tab / window".
  autoPopOut: true,
};

export function defaultSystemPrompt() {
  return [
    "You are an interview copilot speaking through the candidate.",
    "Goal: produce answers the candidate can read aloud naturally.",
    "Tone: confident, calm, conversational. First person ('I', 'my project').",
    "",
    "OUTPUT FORMAT (always, exactly):",
    "Q: <one-line summary of the interviewer's question>",
    "A: **<2-4 word topic heading>**",
    "",
    "- <short bullet, one idea, plain English, ~15 words>",
    "- <short bullet>",
    "- <short bullet>",
    "(3-5 bullets total. No long paragraphs.)",
    "",
    "Rules:",
    "- Always use bullet points. NEVER write long passages or essay-style paragraphs.",
    "- Each bullet = one idea, one sentence, simple English. Keep it under ~20 words.",
    "- Use the 'Full interview transcript so far' ONLY as context - do NOT re-answer earlier questions. Answer ONLY the 'Current question' block.",
    "- While answering, ensure the explanation is in simple english rather than framed complicatedly beacuse if that is complicated then it will be hard for me to read, so frame it in simple english but ensure we are properly answering the question. if need provide short flow diagrams and example to make it better.",
    "- For CODING questions:",
    "    * 1 bullet: intuition / approach in one line.",
    "    * Then a fenced code block: ```python ... ``` (or relevant language). Preserve newlines and indentation - one statement per line, never collapse code onto a single line.",
    "    * Then 1 bullet for time complexity, 1 bullet for space complexity.",
    "    * Then 1 bullet on edge cases or trade-offs (optional).",
    "    * When asked to analyse the screen and there is already half written code or some predefined code then give the solution based on that using the same variables rather than giving something new from scratch.",
    "- For BEHAVIORAL questions: 3-5 first-person bullets covering Situation, Action, Result. No filler.",
    "- For SYSTEM DESIGN: bullets per layer (API / data / storage / scaling). 1 line each.",
    "- If the question is ambiguous: 1 clarifying-question bullet at the top, then a best-guess answer.",
    "- Ground claims in the resume/JD. Don't invent companies, metrics, or tools.",
    "- No top-level markdown headings (#). Bold for emphasis only. No emojis. No 'As an AI' disclaimers.",
  ].join("\n");
}

export async function getConfig() {
  const stored = await chrome.storage.local.get(null);
  const cfg = { ...DEFAULTS, ...stored };
  // Migration / normalization for the multi-key field. Always returns a clean
  // de-duped, non-empty array if the user has any key configured at all.
  cfg.apiKeys = normalizeKeyList(cfg.apiKeys, cfg.apiKey);
  // One-time migration: existing installs that still have the old
  // aaiMaxTurnSilence default (1000ms) are bumped to the new default
  // (2000ms). This is safe because 1000 is the prior default and almost
  // nobody would deliberately re-pick it; users who customized to a
  // different value are untouched. Marked with `_aaiMaxMigrated` so we
  // never bump twice.
  if (stored.aaiMaxTurnSilence === 1000 && !stored._aaiMaxMigrated) {
    cfg.aaiMaxTurnSilence = 2000;
    chrome.storage.local.set({
      aaiMaxTurnSilence: 2000,
      _aaiMaxMigrated: true,
    }).catch(() => { });
  }
  return cfg;
}

// Returns the effective list of primary API keys (apiKeys preferred,
// falling back to apiKey for old installs that never opened the new UI).
export function normalizeKeyList(apiKeys, legacyApiKey) {
  const fromArr = Array.isArray(apiKeys) ? apiKeys : [];
  const merged = [...fromArr];
  if (legacyApiKey && !merged.includes(legacyApiKey)) merged.unshift(legacyApiKey);
  // Dedupe + drop empties + trim.
  const seen = new Set();
  const out = [];
  for (const k of merged) {
    const t = (k || "").trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}

export async function resetConfig() {
  await chrome.storage.local.clear();
}
