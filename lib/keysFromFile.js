// Read API keys from `api-keys.txt` (free-form) or `api-keys.json`
// (structured) bundled into the extension folder.
//
// PARSING STRATEGY
// ----------------
// The free-form .txt parser is intentionally label-agnostic: it scans the
// whole file for tokens that LOOK LIKE provider keys based on their prefix
// shape, then categorises them. This means the user can keep whatever
// human-readable labels they want ("Groq keys :", "assembly backup ...")
// without us having to teach the parser those labels.
//
// SECURITY NOTE
// -------------
// Any file inside the extension folder is bundled into the extension. This
// is fine for a personal dev install loaded as "unpacked", but DO NOT pack
// and distribute the extension while api-keys.txt sits in the folder, or
// every install will leak your keys. .gitignore already covers it; never
// remove that.

// Order matters here - more-specific prefixes are tested before
// less-specific ones, and any token already claimed by a higher-priority
// pattern is skipped on later patterns. That's how `sk-or-v1-...` ends up
// classified as openrouter even though it also matches `sk-...`.
const PATTERNS = [
  { provider: "groq",       re: /\bgsk_[A-Za-z0-9]{40,}\b/g                  },
  { provider: "openrouter", re: /\bsk-or(?:-v1)?-[A-Za-z0-9]{40,}\b/g        },
  { provider: "anthropic",  re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g             },
  { provider: "openai",     re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g       },
  { provider: "gemini",     re: /\bAIza[A-Za-z0-9_-]{30,}\b/g                },
  { provider: "gemini",     re: /\bAQ\.[A-Za-z0-9_-]{40,}\b/g                },
  // AssemblyAI keys are exactly 32 lowercase-hex chars. We anchor on
  // word boundaries to avoid grabbing fragments out of longer ids. Tested
  // last so the more-specific patterns above win first.
  { provider: "assemblyai", re: /\b[a-f0-9]{32}\b/g                          },
];

const EMPTY_RESULT = () => ({
  groq: [], openrouter: [], openai: [], anthropic: [], gemini: [], assemblyai: [],
});

// Free-form parser. Forgiving by design - skips comments and labels.
export function parseKeyFile(text) {
  const out = EMPTY_RESULT();
  if (!text || typeof text !== "string") return out;
  // Strip comment lines so we don't accidentally extract keys inside an
  // explanatory comment. (User's current file has no #comments but this
  // is cheap insurance.)
  const stripped = text
    .split(/\r?\n/)
    .filter((ln) => !/^\s*#/.test(ln))
    .join("\n");

  const seen = new Set();
  for (const { provider, re } of PATTERNS) {
    const matches = stripped.match(re) || [];
    for (const m of matches) {
      if (seen.has(m)) continue;
      seen.add(m);
      out[provider].push(m);
    }
  }
  return out;
}

// Structured JSON parser. Accepts a flat map of provider -> keys[]
// or provider -> single-key string. Unknown keys are ignored.
export function parseKeyJson(json) {
  const out = EMPTY_RESULT();
  if (!json || typeof json !== "object") return out;
  for (const provider of Object.keys(out)) {
    const v = json[provider];
    if (Array.isArray(v))            out[provider] = v.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim());
    else if (typeof v === "string")  out[provider] = v.trim() ? [v.trim()] : [];
  }
  return out;
}

// Try the JSON first, then the text. Returns the first non-empty parse,
// or null if neither file exists / contains anything usable.
export async function loadKeysFromExtensionFiles() {
  const candidates = [
    { name: "api-keys.json", parser: async (r) => parseKeyJson(await r.json()) },
    { name: "api-keys.txt",  parser: async (r) => parseKeyFile(await r.text()) },
  ];
  for (const { name, parser } of candidates) {
    try {
      const url = chrome.runtime.getURL(name);
      const res = await fetch(url);
      if (!res.ok) continue;
      const parsed = await parser(res);
      if (totalKeys(parsed) > 0) {
        return { source: name, keys: parsed };
      }
    } catch { /* file missing or unreadable - try the next one */ }
  }
  return null;
}

export function totalKeys(parsed) {
  if (!parsed) return 0;
  let n = 0;
  for (const k of Object.keys(parsed)) n += parsed[k]?.length || 0;
  return n;
}

// Convert a parsed file (categorised key map) into a chrome.storage.local
// patch, given the user's current cfg. We only touch fields that the file
// actually has data for - if the user manually entered an OpenAI key but
// the file only has Groq keys, the OpenAI key is left alone.
export function buildConfigPatch(parsed, cfg) {
  const patch = {};
  if (!parsed) return patch;

  // Primary: rotate over apiKeys[] for the currently-selected provider.
  const primaryList = parsed[cfg.provider] || [];
  if (primaryList.length) {
    patch.apiKeys = primaryList;
    patch.apiKey  = "";  // legacy field cleared so it doesn't shadow the pool
  }

  // Fallback: single key for the currently-selected fallback provider.
  if (cfg.fallbackProvider && parsed[cfg.fallbackProvider]?.length) {
    patch.fallbackApiKey = parsed[cfg.fallbackProvider][0];
  }

  // STT: AssemblyAI uses its own key field. Whisper providers reuse the
  // chat key, so we don't need to touch sttApiKey for them.
  if (cfg.sttProvider === "assemblyai" && parsed.assemblyai?.length) {
    patch.sttApiKey = parsed.assemblyai[0];
  }

  return patch;
}
