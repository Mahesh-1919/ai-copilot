// Background service worker. Central router between popup, offscreen audio
// capture, and the in-tab content-script panel. Also runs the LLM streaming.

import { getConfig, setConfig } from "./lib/storage.js";
import {
  makeChatProvider,
  getVisionModelOverride,
  fallbackConfig,
  fallbackVisionModel,
  expandFallbackChain,
  KeyPool,
  LLMHttpError,
} from "./lib/providers.js";
import { mintStreamingToken } from "./lib/aaiStreaming.js";
import {
  loadKeysFromExtensionFiles,
  buildConfigPatch,
  totalKeys,
} from "./lib/keysFromFile.js";

const OFFSCREEN_PATH = "offscreen.html";

const state = {
  active: false,
  tabId: null,
  windowId: null,
  transcript: [],
  livePartial: "",
  // Index into state.transcript marking the boundary between "already answered"
  // turns and turns that belong to the CURRENT question. After each successful
  // answer we advance this to transcript.length, so the next question doesn't
  // get blended with the previous one (which was causing the model to keep
  // re-explaining old topics).
  consumedTurnIdx: 0,
  currentAnswerAbort: null,
  // Per-key health for the primary provider's apiKeys[] rotation pool.
  // Shape: { [keyTag]: { until: number|null, dead: bool, lastError: string } }
  // Persisted to chrome.storage.session so cooldowns survive SW restarts and
  // the "all keys exhausted -> skip primary entirely" decision stays sticky
  // across the natural ~30s SW idle teardown.
  keyHealth: {},
  // True when the user has hit "Pause" in the panel. Audio capture and STT
  // continue running, but we DROP all transcript-text/transcript-partial
  // updates and never trigger an auto-answer - so the interviewer's voice
  // doesn't blow up the answer card while the user is typing in their
  // editor. Resume restores normal operation instantly.
  paused: false,
};

// Hydrate transient state from chrome.storage.session as soon as the SW boots.
// chrome.storage.session is in-memory only (cleared when Chrome restarts), so
// it's a safe place to mirror the live transcript. Without this, an MV3
// service-worker restart mid-session would silently drop the transcript and
// every subsequent auto-answer would have nothing to work with.
const SESSION_STATE_KEY = "ic_session_state";
let stateHydrated = false;
const hydratePromise = (async () => {
  try {
    if (chrome.storage?.session) {
      const data = await chrome.storage.session.get(SESSION_STATE_KEY);
      const saved = data[SESSION_STATE_KEY];
      if (saved && typeof saved === "object") {
        state.active           = !!saved.active;
        state.tabId            = saved.tabId       ?? null;
        state.windowId         = saved.windowId    ?? null;
        state.transcript       = Array.isArray(saved.transcript) ? saved.transcript : [];
        state.livePartial      = saved.livePartial ?? "";
        state.consumedTurnIdx  = Number.isFinite(saved.consumedTurnIdx)
          ? Math.min(saved.consumedTurnIdx, state.transcript.length)
          : 0;
        state.keyHealth        = (saved.keyHealth && typeof saved.keyHealth === "object") ? saved.keyHealth : {};
        state.paused           = !!saved.paused;
      }
    }
  } catch { /* non-fatal */ }
  stateHydrated = true;
})();

async function persistState() {
  if (!chrome.storage?.session) return;
  try {
    await chrome.storage.session.set({
      [SESSION_STATE_KEY]: {
        active:          state.active,
        tabId:           state.tabId,
        windowId:        state.windowId,
        transcript:      state.transcript,
        livePartial:     state.livePartial,
        consumedTurnIdx: state.consumedTurnIdx,
        keyHealth:       state.keyHealth,
        paused:          state.paused,
      },
    });
  } catch { /* non-fatal */ }
}

// ---------- Offscreen lifecycle ----------

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for live interview transcription.",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ---------- Panel messaging (content script) ----------

// Browser-internal URL schemes where Chrome refuses to inject content
// scripts. Skip these in sendToPanel() to avoid spamming sendMessage
// rejections on every transcript-partial broadcast.
const NON_INJECTABLE_RE = /^(chrome|edge|brave|opera|about|chrome-extension|devtools|view-source|file):/i;

function sendToPanel(msg) {
  // We fan out to EVERY loaded tab, not just state.tabId. Reason: the
  // user wants the AS badge clickable from any tab they happen to be
  // looking at mid-interview (Programiz for code, ChatGPT scratch-pad,
  // a Google search, etc.) - not only the Meet/Zoom tab. Each tab's
  // content script renders its own panel root + badge and stays in sync
  // via these same broadcasts, so popping the panel out from any tab
  // shows the same transcript and answer.
  //
  // Cost: one chrome.tabs.sendMessage IPC per loaded tab per broadcast.
  // For N=10 typical tabs and up to ~10Hz transcript-partial frequency
  // that's ~100 IPCs/sec, well within Chrome's budget.
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (!t.id) continue;
      const url = t.url || t.pendingUrl || "";
      if (NON_INJECTABLE_RE.test(url)) continue;
      chrome.tabs.sendMessage(t.id, msg).catch(() => {
        // Tab may have navigated, closed, or simply not have our content
        // script loaded yet (race on a brand-new tab). All benign.
      });
    }
  });
}

async function ensurePanelInjected(tabId) {
  // Programmatically inject in case the meeting tab was loaded before the
  // extension was installed/reloaded (in which case the manifest's
  // content_scripts entry didn't run).
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/panel.css"],
    });
  } catch { /* ok if already present */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/panel.js"],
    });
  } catch { /* ok if already present */ }
}

// ---------- Session control ----------

async function startSession({ tabId, windowId, streamId }) {
  console.log("[IC bg] start-session", { tabId, windowId, hasStreamId: !!streamId });
  // Always tear down any prior session first - this releases the previous
  // tabCapture stream cleanly so getUserMedia(newStreamId) works the second
  // time around.
  await stopSession({ silent: true });

  state.active = true;
  state.paused = false;
  state.tabId = tabId;
  state.windowId = windowId ?? null;
  state.transcript = [];
  state.livePartial = "";
  state.consumedTurnIdx = 0;
  await persistState();

  try {
    const cfg = await getConfig();

    let aaiToken = null;
    if (cfg.sttProvider === "assemblyai") {
      const key = (cfg.sttApiKey || "").trim();
      if (!key) throw new Error("AssemblyAI API key missing - set it in Options (STT API key field).");
      try {
        console.log("[IC bg] minting AssemblyAI token");
        aaiToken = await mintStreamingToken(key, 600);
      } catch (e) {
        throw new Error(`AssemblyAI token mint failed: ${e?.message || e}`);
      }
    }

    console.log("[IC bg] ensuring panel + offscreen");
    await ensurePanelInjected(tabId);
    await ensureOffscreen();

    console.log("[IC bg] sending start-capture to offscreen");
    let captureRes;
    try {
      captureRes = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "start-capture",
        streamId,
        cfg,
        aaiToken,
      });
    } catch (e) {
      throw new Error(`offscreen unreachable: ${e?.message || e}`);
    }
    if (!captureRes?.ok) {
      throw new Error(captureRes?.error || "audio capture failed (no error returned)");
    }
    console.log("[IC bg] capture started");

    sendToPanel({ type: "panel-show", autoPopOut: !!cfg.autoPopOut });
    broadcast({ type: "session-state", active: true });
  } catch (e) {
    console.error("[IC bg] start-session failed:", e);
    // Roll back so the user can hit Start again without being wedged in
    // active=true forever.
    state.active = false;
    await persistState();
    try { await closeOffscreen(); } catch {}
    broadcast({ type: "session-state", active: false });
    broadcast({ type: "error", error: String(e?.message || e) });
    throw e;
  }
}

async function stopSession({ silent = false } = {}) {
  console.log("[IC bg] stop-session", { wasActive: state.active, silent });
  if (state.currentAnswerAbort) {
    state.currentAnswerAbort.abort();
    state.currentAnswerAbort = null;
  }
  if (state.active) {
    try {
      // Wait for offscreen to actually finish stopCapture before we close
      // the document - otherwise the previous AudioContext / mediaStream
      // can linger long enough to make the next getUserMedia(streamId) fail
      // with "Could not start audio source" on rapid Stop -> Start.
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stop-capture" });
    } catch (e) {
      console.warn("[IC bg] stop-capture message failed (offscreen may already be gone):", e?.message || e);
    }
  }
  try { await closeOffscreen(); } catch (e) {
    console.warn("[IC bg] closeOffscreen failed:", e?.message || e);
  }
  state.active = false;
  state.paused = false;
  state.livePartial = "";
  await persistState();
  if (!silent) {
    broadcast({ type: "session-state", active: false, paused: false });
    broadcast({ type: "transcript-partial", text: "" });
    // Tear down the badge on EVERY tab. Without this, badges keep
    // floating in every tab even after the user clicked End, which is
    // the obvious visual giveaway we just spent so much effort to avoid.
    sendToPanel({ type: "panel-hide" });
  }
}

// ---------- Transcript + LLM streaming ----------

function appendTranscript(text) {
  // While paused we ACK and drop. Audio + STT keep running on the wire so
  // resume is instant, but the LLM never sees what the interviewer says
  // and the answer card stays untouched while the user types code.
  if (state.paused) return;
  const t = (text || "").trim();
  if (!t) return;
  state.transcript.push({ ts: Date.now(), text: t });
  state.livePartial = "";
  // Cap transcript history so storage.session writes stay cheap. We only ever
  // prompt with the last few turns anyway.
  if (state.transcript.length > 200) {
    const trim = state.transcript.length - 200;
    state.transcript = state.transcript.slice(trim);
    state.consumedTurnIdx = Math.max(0, state.consumedTurnIdx - trim);
  }
  persistState();
  broadcast({ type: "transcript-append", text: t });
  broadcast({ type: "transcript-partial", text: "" });

  scheduleAutoAnswer();
}

function setLivePartial(text) {
  if (state.paused) return;
  state.livePartial = (text || "").trim();
  broadcast({ type: "transcript-partial", text: state.livePartial });
}

function setPaused(paused) {
  const next = !!paused;
  if (state.paused === next) return;
  state.paused = next;
  // Cancel any in-flight answer when pausing - the user might be about to
  // type code and doesn't want the answer card refreshing under them.
  if (next && state.currentAnswerAbort) {
    try { state.currentAnswerAbort.abort(); } catch {}
  }
  if (next) {
    // Wipe the live caption so nothing keeps fading in/out under the cursor.
    state.livePartial = "";
    broadcast({ type: "transcript-partial", text: "" });
    // Mark every transcript so far as "consumed" - on resume the LLM will
    // only answer what the interviewer says AFTER resume, not the trailing
    // bit that arrived while the user was hitting Pause.
    state.consumedTurnIdx = state.transcript.length;
  }
  persistState();
  broadcast({ type: "session-state", active: state.active, paused: state.paused });
}

let autoAnswerTimer = null;

// --- Auto-answer debounce + "incomplete question" heuristic --------------
//
// We give every newly-finalized turn a debounce window before kicking off
// the LLM, so two finals arriving back-to-back collapse into one answer.
// On top of that, we look at the cumulative current-question text and, if
// it strongly looks like the speaker is still mid-thought (trailing comma,
// connector word, no terminal punctuation, etc.), we extend the window.
//
// Both windows are user-configurable via Settings (autoAnswerDebounceMs /
// autoAnswerDebounceIncompleteMs). Constants below are only the floor we
// fall back to if Settings ever yields a non-numeric value.
const DEBOUNCE_NORMAL_FALLBACK_MS     = 800;
const DEBOUNCE_INCOMPLETE_FALLBACK_MS = 2000;

// Single-token tails that strongly imply "another burst is coming".
// All entries are lowercased and matched against the LAST whitespace-
// separated token of the current question (after stripping punctuation).
const CONTINUATION_TAIL = new Set([
  // conjunctions / clause linkers
  "and", "or", "but", "so", "because", "since", "while", "when", "where",
  "if", "unless", "though", "although", "as", "than", "that", "which",
  "whether",
  // prepositions
  "of", "to", "for", "with", "without", "by", "on", "in", "into", "at",
  "from", "about", "over", "under", "between", "through", "across",
  "after", "before", "during",
  // articles / determiners
  "the", "a", "an", "this", "that", "these", "those", "your", "my", "our",
  "their", "his", "her",
  // aux / copulas / modals
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "can", "could", "will", "would", "should", "shall",
  "may", "might", "must", "ought",
  // pronouns left dangling
  "i", "you", "we", "they", "he", "she", "it", "me", "him", "her", "them",
  "us",
  // common spoken fillers
  "uh", "um", "ah", "er", "like", "well",
]);

// Two-token tails - phrases that almost always precede more content.
const CONTINUATION_TWO = new Set([
  "you know", "kind of", "sort of", "i mean", "you see",
  "for example", "such as", "in other words", "as in",
  "let me", "going to", "want to", "need to", "have to",
]);

// Conservative version of the heuristic: ONLY flag as incomplete when we
// see an explicit "still talking" signal (trailing connector word, comma,
// dash, colon, etc.). If we see neither a strong "done" signal nor a
// strong "still talking" signal, default to COMPLETE - because:
//   1. AAI's max_turn_silence (2s default) already ensures the speaker
//      went silent for >=2s before this turn was even emitted, which is
//      itself strong evidence the question is over.
//   2. AAI Universal-3 Pro doesn't always emit terminal punctuation
//      (especially for short utterances), so "no period" is a weak
//      signal that should NOT block the answer.
// Earlier version defaulted to incomplete for unpunctuated text, which
// made every plain-English question wait the full 2s and looked broken.
function looksIncomplete(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  // Strong COMPLETE: ends with terminal punctuation (optionally followed
  // by a closing quote / paren / bracket).
  if (/[.!?][)\]"\u201d']?\s*$/.test(trimmed)) return false;
  // Strong INCOMPLETE: trailing comma / colon / em-dash / hyphen.
  if (/[,;:\u2014\-]\s*$/.test(trimmed)) return true;
  // Trailing-word check.
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const last1 = tokens[tokens.length - 1];
  const last2 = tokens.slice(-2).join(" ");
  if (CONTINUATION_TAIL.has(last1)) return true;
  if (CONTINUATION_TWO.has(last2))  return true;
  // Default: treat as complete. AAI already gave us 2s of silence before
  // this final fired, so it really is a turn boundary.
  return false;
}

// Coerce to a positive integer, falling back to `dflt` if value is missing
// or unparseable. Used to read the debounce knobs from Settings safely.
function clampMs(value, dflt, min = 0, max = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function scheduleAutoAnswer() {
  let wait = DEBOUNCE_NORMAL_FALLBACK_MS;
  try {
    const cfg = await getConfig();
    if (!cfg.autoAnswer) return;
    const normalMs     = clampMs(cfg.autoAnswerDebounceMs,           DEBOUNCE_NORMAL_FALLBACK_MS,     50, 30000);
    const incompleteMs = clampMs(cfg.autoAnswerDebounceIncompleteMs, DEBOUNCE_INCOMPLETE_FALLBACK_MS, 50, 30000);
    wait = normalMs;
    // Inspect the same text the LLM would actually see. If the speaker
    // is still mid-question, extend the debounce. The next final will
    // reset the timer entirely, so we never miss the *real* end.
    const ctx = buildQuestionContext();
    if (looksIncomplete(ctx.currentQuestion)) wait = incompleteMs;
  } catch (e) {
    // Defensive: a regression in buildQuestionContext / looksIncomplete
    // must never wedge auto-answer. Fall back to the normal debounce
    // and let generateAnswer() raise its own error if there's a bigger
    // problem.
    console.warn("[IC bg] scheduleAutoAnswer heuristic threw:", e?.message || e);
  }
  if (autoAnswerTimer) clearTimeout(autoAnswerTimer);
  autoAnswerTimer = setTimeout(
    () => generateAnswer().catch((e) => broadcast({ type: "error", error: String(e) })),
    wait,
  );
}

// ---------- Provider streaming with fallback ----------

// Stream from `primary`, but if the very first call fails with a retryable
// error (429 quota, 5xx, network) AND no tokens have streamed yet, switch
// transparently to `fallback`. Once any delta has been emitted, errors
// propagate to the caller (we don't want to splice two different model
// outputs together).
async function* streamWithFallback({
  primary,
  fallbacks,            // array of { label, run, onError? } - run() returns a generator
  onFallback,           // optional notification callback (label, error)
}) {
  const attempts = [primary, ...(fallbacks || [])].filter(Boolean);
  let lastErr = null;
  // Treat 401/403 as retryable AT THE ATTEMPT LEVEL even though it's not
  // generally retryable - the next attempt may use a different key entirely.
  const isAttemptSwitchable = (e) => {
    if (!(e instanceof LLMHttpError)) return false;
    return e.isRetryable() || e.isAuthFailure();
  };
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    let producedAny = false;
    try {
      for await (const delta of attempt.run()) {
        producedAny = true;
        yield delta;
      }
      return;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      // Let the attempt record the failure (e.g. mark its key cooling).
      try { attempt.onError?.(e); } catch {}
      // If we already streamed tokens, we can't switch providers without
      // confusing the UI. Bubble the error so the user sees something.
      if (producedAny) throw e;
      if (!isAttemptSwitchable(e)) throw e;
      const next = attempts[i + 1];
      if (!next) throw e;
      try { onFallback?.(next.label, e); } catch {}
      // loop continues to next attempt
    }
  }
  if (lastErr) throw lastErr;
}

// Build the ordered list of primary attempts (one per still-available API
// key). Returns `{ attempts, pool, exhausted }`. When `exhausted` is true
// the caller should skip the primary entirely and go straight to the
// fallback chain - all keys are either dead or still cooling.
function buildPrimaryAttempts({ cfg, runForKey, label }) {
  const pool = new KeyPool({
    keys: cfg.apiKeys || [],
    health: state.keyHealth,
    cooldownDefaultMs: cfg.keyCooldownDefaultMs || 5 * 60 * 1000,
  });
  if (pool.size() === 0) {
    // No keys configured at all - try a single attempt anyway so the user
    // gets a clear "no API key" error from the provider layer.
    return {
      pool,
      exhausted: false,
      attempts: [{
        label: `${label} (no key)`,
        run: () => runForKey(""),
      }],
    };
  }
  const live = pool.availableKeys();
  if (live.length === 0) {
    return { pool, exhausted: true, attempts: [] };
  }
  const totalKeys = pool.size();
  const attempts = live.map((key) => {
    const idx = cfg.apiKeys.indexOf(key);
    const tag = `key #${idx + 1}/${totalKeys}`;
    return {
      label: `${label} (${tag})`,
      key,
      run: () => runForKey(key),
      onError: (err) => {
        const marked = pool.applyError(key, err);
        if (marked) {
          // Persist immediately so a SW restart between attempts still
          // remembers this key is cooling.
          persistState();
          broadcast({
            type: "info",
            info: err instanceof LLMHttpError && err.isAuthFailure()
              ? `Primary ${tag} rejected (HTTP ${err.status}). Marking dead and trying next key.`
              : `Primary ${tag} hit HTTP ${err?.status || "?"}. Cooling and trying next key.`,
          });
        }
      },
    };
  });
  return { pool, exhausted: false, attempts };
}

function buildSystemPrompt(cfg) {
  const grounding = [];
  if (cfg.resume?.trim())         grounding.push(`Candidate resume:\n${cfg.resume.trim()}`);
  if (cfg.jobDescription?.trim()) grounding.push(`Job description:\n${cfg.jobDescription.trim()}`);
  return grounding.length
    ? `${cfg.systemPrompt}\n\n---\n\n${grounding.join("\n\n---\n\n")}`
    : cfg.systemPrompt;
}

// Split the transcript into the CURRENT question (turns since the last
// answered one) and the EARLIER interview history (everything before that).
// Both are passed to the LLM - the earlier slice for full interview context,
// the current slice as the thing to actually answer.
//
// Returns `{ currentQuestion, earlierContext, snapshotIdx }` where
// `snapshotIdx` is the index we advance `consumedTurnIdx` to after a
// successful answer.
const MAX_CURRENT_QUESTION_CHARS = 4000;     // ~1000 tokens - the active turn
const MAX_EARLIER_CONTEXT_CHARS  = 12000;    // ~3000 tokens - prior interview

function buildQuestionContext() {
  const transcript = state.transcript;
  const consumed   = Math.min(state.consumedTurnIdx, transcript.length);

  // If new turns have arrived since the last answer, those ARE the current
  // question. If nothing has changed (user clicked "Answer Question" without
  // speaking), re-answer the most recent burst of turns.
  let startIdx = consumed;
  if (startIdx >= transcript.length) {
    startIdx = Math.max(0, transcript.length - 6);
    for (let i = transcript.length - 1; i > startIdx; i--) {
      const gap = transcript[i].ts - transcript[i - 1].ts;
      if (gap > 6000) { startIdx = i; break; }
    }
  }

  const currentTurns = transcript.slice(startIdx);
  const earlierTurns = transcript.slice(0, startIdx);

  let currentQuestion = currentTurns.map((t) => t.text).join(" ").trim();
  let earlierContext  = earlierTurns.map((t) => t.text).join(" ").trim();
  if (currentQuestion.length > MAX_CURRENT_QUESTION_CHARS) {
    currentQuestion = currentQuestion.slice(-MAX_CURRENT_QUESTION_CHARS);
  }
  if (earlierContext.length > MAX_EARLIER_CONTEXT_CHARS) {
    // Keep the tail (most recent earlier turns) - that's the most relevant
    // for follow-ups and natural callbacks ("...like the system you just
    // mentioned").
    earlierContext = "[earlier turns truncated] " + earlierContext.slice(-MAX_EARLIER_CONTEXT_CHARS);
  }

  return {
    currentQuestion,
    earlierContext,
    snapshotIdx: transcript.length,
  };
}

async function generateAnswer({ override } = {}) {
  const cfg = await getConfig();
  if (state.currentAnswerAbort) state.currentAnswerAbort.abort();
  const ac = new AbortController();
  state.currentAnswerAbort = ac;

  const systemPrompt = buildSystemPrompt(cfg);

  let userText, snapshotIdx;
  if (override?.trim()) {
    userText =
      `Current question (ANSWER THIS):\n"""\n${override.trim()}\n"""\n\n` +
      `Reply in the required Q:/A: format. Use short bullet points in plain English - no long paragraphs.`;
    snapshotIdx = state.transcript.length;
  } else {
    const ctx = buildQuestionContext();
    if (!ctx.currentQuestion) return;
    snapshotIdx = ctx.snapshotIdx;
    userText =
      (ctx.earlierContext
        ? `Full interview transcript so far (use as context - do NOT re-answer any of it):\n"""\n${ctx.earlierContext}\n"""\n\n`
        : "") +
      `Current question (ANSWER ONLY THIS):\n"""\n${ctx.currentQuestion}\n"""\n\n` +
      `Reply in the required Q:/A: format. Use short bullet points in plain English - no long paragraphs.`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userText },
  ];
  const opts = { signal: ac.signal, temperature: 0.3, maxTokens: 1024 };

  const { attempts: primaryAttempts, exhausted } = buildPrimaryAttempts({
    cfg,
    label: `${cfg.provider} ${cfg.model}`,
    runForKey: (key) => makeChatProvider({ ...cfg, apiKey: key }).streamChat(messages, opts),
  });
  if (exhausted) {
    broadcast({
      type: "info",
      info: `All ${cfg.apiKeys.length} primary key(s) exhausted - going straight to fallback.`,
    });
  }
  const fbCfg = fallbackConfig(cfg);
  // For OpenRouter free tier, walk through several models on 429 because
  // upstream providers throttle individual models independently.
  const fallbacks = expandFallbackChain(fbCfg).map((fb) => ({
    label: `${fb.provider} ${fb.model}`,
    run: () => makeChatProvider(fb).streamChat(messages, opts),
  }));

  // Chain: primary[0..N] then fallback[0..M]. If primary is exhausted the
  // chain starts directly at the fallback.
  const head = primaryAttempts[0];
  const rest = primaryAttempts.slice(1).concat(fallbacks);

  broadcast({ type: "answer-begin" });
  let succeeded = false;
  try {
    if (!head && rest.length === 0) {
      throw new Error("No primary keys available and no fallback configured. Open Options to add keys or enable a fallback.");
    }
    for await (const delta of streamWithFallback({
      primary: head || rest.shift(),
      fallbacks: rest,
      onFallback: (label, err) => {
        broadcast({
          type: "info",
          info: `Switching to ${label} (last attempt: HTTP ${err?.status || "?"}).`,
        });
      },
    })) {
      broadcast({ type: "answer-delta", delta });
    }
    succeeded = true;
    broadcast({ type: "answer-end" });
  } catch (e) {
    if (e.name === "AbortError") {
      broadcast({ type: "answer-end", aborted: true });
    } else {
      broadcast({ type: "error", error: friendlyLLMError(e) });
      broadcast({ type: "answer-end", error: true });
    }
  } finally {
    if (state.currentAnswerAbort === ac) state.currentAnswerAbort = null;
    if (succeeded) {
      // Mark these turns as answered so the next request focuses on whatever
      // the interviewer says NEXT instead of re-answering this question.
      state.consumedTurnIdx = Math.min(snapshotIdx, state.transcript.length);
      persistState();
    }
  }
}

async function analyseScreen() {
  if (state.tabId == null || state.windowId == null) {
    broadcast({ type: "error", error: "No active session - start one first." });
    return;
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(state.windowId, { format: "png" });
  } catch (e) {
    broadcast({ type: "error", error: `Screen capture failed: ${e?.message || e}` });
    return;
  }
  if (!dataUrl) {
    broadcast({ type: "error", error: "Screen capture returned no image." });
    return;
  }

  const cfg = await getConfig();
  if (state.currentAnswerAbort) state.currentAnswerAbort.abort();
  const ac = new AbortController();
  state.currentAnswerAbort = ac;

  const systemPrompt = buildSystemPrompt(cfg);
  const ctx = buildQuestionContext();
  const snapshotIdx = ctx.snapshotIdx;

  const userParts = [
    {
      type: "text",
      text:
        `The interviewer is currently sharing the screen below. ` +
        `Use the screen content as the primary source of the question.\n\n` +
        (ctx.earlierContext
          ? `Full interview transcript so far (use as context - do NOT re-answer any of it):\n"""\n${ctx.earlierContext}\n"""\n\n`
          : "") +
        (ctx.currentQuestion
          ? `Latest spoken question (ANSWER THIS, combined with the screen):\n"""\n${ctx.currentQuestion}\n"""\n\n`
          : "") +
        `Reply in the required Q:/A: format using short bullet points in plain English - no long paragraphs. ` +
        `Solve any visible problem (LeetCode, system-design diagram, whiteboard prompt) directly.`,
    },
    { type: "image", dataUrl },
  ];
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userParts },
  ];
  const visionModel = getVisionModelOverride(cfg);
  const visionOpts = { signal: ac.signal, temperature: 0.3, maxTokens: 1500, modelOverride: visionModel };

  const { attempts: primaryAttempts, exhausted } = buildPrimaryAttempts({
    cfg,
    label: `${cfg.provider} ${visionModel}`,
    runForKey: (key) => makeChatProvider({ ...cfg, apiKey: key }).streamChatVision(messages, visionOpts),
  });
  if (exhausted) {
    broadcast({
      type: "info",
      info: `All ${cfg.apiKeys.length} primary key(s) exhausted - using fallback for vision.`,
    });
  }
  const fbCfg = fallbackConfig(cfg);
  const fbChain = expandFallbackChain(fbCfg);
  // For each fallback chat-cfg we also need a vision model for that attempt;
  // most preset entries carry a _visionChain on them after expansion.
  const fallbacks = fbChain.flatMap((fb) => {
    const vmList = fb._visionChain && fb._visionChain.length
      ? fb._visionChain
      : [fallbackVisionModel(fb)];
    return vmList.map((vm) => ({
      label: `${fb.provider} ${vm} (chat=${fb.model})`,
      run: () => makeChatProvider(fb).streamChatVision(messages, {
        signal: ac.signal, temperature: 0.3, maxTokens: 1500, modelOverride: vm,
      }),
    }));
  });

  const head = primaryAttempts[0];
  const rest = primaryAttempts.slice(1).concat(fallbacks);

  broadcast({ type: "answer-begin" });
  let succeeded = false;
  try {
    if (!head && rest.length === 0) {
      throw new Error("No primary keys available and no fallback configured.");
    }
    for await (const delta of streamWithFallback({
      primary: head || rest.shift(),
      fallbacks: rest,
      onFallback: (label, err) => {
        broadcast({
          type: "info",
          info: `Switching to ${label} (last attempt: HTTP ${err?.status || "?"}).`,
        });
      },
    })) {
      broadcast({ type: "answer-delta", delta });
    }
    succeeded = true;
    broadcast({ type: "answer-end" });
  } catch (e) {
    if (e.name === "AbortError") {
      broadcast({ type: "answer-end", aborted: true });
    } else {
      broadcast({ type: "error", error: `Vision call failed: ${friendlyLLMError(e)}` });
      broadcast({ type: "answer-end", error: true });
    }
  } finally {
    if (state.currentAnswerAbort === ac) state.currentAnswerAbort = null;
    if (succeeded) {
      state.consumedTurnIdx = Math.min(snapshotIdx, state.transcript.length);
      persistState();
    }
  }
}

function friendlyLLMError(e) {
  if (e instanceof LLMHttpError) {
    if (e.status === 429) {
      return `${e.provider}: quota / rate limit hit (HTTP 429). ` +
             `Configure a fallback provider in Options to stay live.`;
    }
    if (e.status === 401 || e.status === 403) {
      return `${e.provider}: API key rejected (HTTP ${e.status}).`;
    }
    if (e.status === 404 && /no endpoints found/i.test(e.body)) {
      // OpenRouter rotated this model out of the :free tier (or rotated it
      // out entirely). Tell the user to refresh the model list.
      return `${e.provider}: model "${e.model}" is not currently available. ` +
             `Open Options -> Fallback LLM -> click "Refresh free models" and pick another one.`;
    }
    if (e.status === 404) {
      return `${e.provider}: model "${e.model}" not found (HTTP 404). Check the model id.`;
    }
    if (e.status >= 500) {
      return `${e.provider}: provider outage (HTTP ${e.status}). Try again in a moment.`;
    }
  }
  return String(e?.message || e);
}

// ---------- Message router ----------

function broadcast(msg) {
  // Send to runtime contexts (popup, offscreen, options) AND to the meeting tab's panel.
  chrome.runtime.sendMessage(msg).catch(() => {});
  sendToPanel(msg);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!stateHydrated) await hydratePromise;
      switch (msg.type) {
        case "start-session":
          await startSession({ tabId: msg.tabId, windowId: msg.windowId, streamId: msg.streamId });
          sendResponse({ ok: true });
          break;
        case "stop-session":
          await stopSession();
          sendResponse({ ok: true });
          break;
        case "get-session-state":
          sendResponse({
            active: state.active,
            paused: state.paused,
            transcript: state.transcript,
            livePartial: state.livePartial,
            tabId: state.tabId,
          });
          break;
        case "transcript-text":
          appendTranscript(msg.text);
          sendResponse({ ok: true });
          break;
        case "transcript-partial":
          setLivePartial(msg.text);
          sendResponse({ ok: true });
          break;
        case "manual-transcript":
          appendTranscript(msg.text);
          sendResponse({ ok: true });
          break;
        case "regenerate":
          await generateAnswer({ override: msg.override });
          sendResponse({ ok: true });
          break;
        case "analyse-screen":
          await analyseScreen();
          sendResponse({ ok: true });
          break;
        case "abort":
          if (state.currentAnswerAbort) state.currentAnswerAbort.abort();
          sendResponse({ ok: true });
          break;
        case "pause-session":
          setPaused(true);
          sendResponse({ ok: true });
          break;
        case "resume-session":
          setPaused(false);
          sendResponse({ ok: true });
          break;
        case "clear-transcript":
          state.transcript = [];
          state.livePartial = "";
          state.consumedTurnIdx = 0;
          await persistState();
          broadcast({ type: "transcript-cleared" });
          broadcast({ type: "transcript-partial", text: "" });
          sendResponse({ ok: true });
          break;
        case "panel-ready":
          // Content script announces it's loaded on a tab. If a session is
          // currently active, send panel-show + session-state to THIS tab
          // so its badge appears immediately. Applies to ANY tab now (not
          // just the meeting tab) because the user wants to be able to
          // pop the panel back open from any tab they're working in.
          if (state.active && sender.tab?.id != null) {
            const cfg2 = await getConfig();
            chrome.tabs.sendMessage(sender.tab.id, {
              type: "panel-show",
              autoPopOut: !!cfg2.autoPopOut,
            }).catch(() => {});
            chrome.tabs.sendMessage(sender.tab.id, {
              type: "session-state",
              active: true,
              paused: !!state.paused,
            }).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        case "get-key-health": {
          // Used by the Options page to render per-key status badges.
          const cfgK = await getConfig();
          const pool = new KeyPool({
            keys: cfgK.apiKeys || [],
            health: state.keyHealth,
            cooldownDefaultMs: cfgK.keyCooldownDefaultMs || 5 * 60 * 1000,
          });
          sendResponse({ ok: true, status: pool.status() });
          break;
        }
        case "reset-key-health": {
          if (msg.keyTag) {
            // Reset a single key by its tag (we never round-trip raw keys).
            delete state.keyHealth[msg.keyTag];
          } else {
            for (const k of Object.keys(state.keyHealth)) delete state.keyHealth[k];
          }
          await persistState();
          sendResponse({ ok: true });
          break;
        }
        case "reload-keys-from-file": {
          // Triggered by the Options page button. Re-read api-keys.{json,txt}
          // and report a summary so the UI can show "Loaded N Groq + 1
          // OpenRouter + 1 AssemblyAI". Cooldowns are also cleared because
          // the keys themselves may have changed.
          for (const k of Object.keys(state.keyHealth)) delete state.keyHealth[k];
          await persistState();
          const summary = await syncKeysFromFile();
          sendResponse({ ok: !!summary, summary });
          break;
        }
        case "reload-resume-from-file": {
          const docs = await syncDocsFromFile({ silent: true });
          sendResponse({ ok: !!docs.resume, summary: docs.resume });
          break;
        }
        case "reload-jd-from-file": {
          const docs = await syncDocsFromFile({ silent: true });
          sendResponse({ ok: !!docs.jobDescription, summary: docs.jobDescription });
          break;
        }
        case "ping":
          sendResponse({ ok: true, pong: true });
          break;
        default:
          sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) stopSession().catch(() => {});
});

chrome.runtime.onSuspend?.addListener(() => stopSession().catch(() => {}));

// ---------- Auto-sync keys from api-keys.{json,txt} ----------
//
// Every time the extension is installed/updated/reloaded OR Chrome boots,
// we re-read the bundled key file and write its contents into
// chrome.storage.local. This way the user can edit api-keys.txt, hit
// "Reload" at chrome://extensions, and the new keys are live without
// touching the Options UI.
async function syncKeysFromFile({ silent = false } = {}) {
  let parsed = null;
  try {
    const loaded = await loadKeysFromExtensionFiles();
    if (!loaded) {
      if (!silent) console.log("[IC] no api-keys.{json,txt} found in extension folder; skipping sync");
      return null;
    }
    parsed = loaded.keys;
    const cfg   = await getConfig();
    const patch = buildConfigPatch(parsed, cfg);
    if (Object.keys(patch).length) {
      await setConfig(patch);
    }
    const summary = {
      source: loaded.source,
      total:  totalKeys(parsed),
      primary:  patch.apiKeys?.length || 0,
      fallback: patch.fallbackApiKey ? 1 : 0,
      stt:      patch.sttApiKey      ? 1 : 0,
      // Per-provider counts so the user can confirm in DevTools that
      // every key they expect was picked up.
      counts:  Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.length])),
    };
    console.log("[IC] keys synced from", loaded.source, summary);
    return summary;
  } catch (e) {
    console.warn("[IC] key file sync failed:", e?.message || e);
    return null;
  }
}

// ---------- Auto-sync resume / job description from local files ----------
//
// Same pattern as syncKeysFromFile: drop a `resume.txt` (or .md) and a
// `job-description.txt` (or .md / `jd.txt` / `jd.md`) at the extension
// root, and the SW pushes them into chrome.storage on every reload.
const RESUME_CANDIDATES = ["resume.md", "resume.txt"];
const JD_CANDIDATES     = ["job-description.md", "job-description.txt", "jd.md", "jd.txt"];

async function loadFirstTextFile(candidates) {
  for (const name of candidates) {
    try {
      const url = chrome.runtime.getURL(name);
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.trim().length > 0) return { name, text: text.trim() };
    } catch { /* file missing - try next */ }
  }
  return null;
}

async function syncDocsFromFile({ silent = false } = {}) {
  const summary = { resume: null, jobDescription: null };
  const patch = {};
  try {
    const resume = await loadFirstTextFile(RESUME_CANDIDATES);
    if (resume) {
      patch.resume = resume.text;
      summary.resume = { source: resume.name, length: resume.text.length };
    }
    const jd = await loadFirstTextFile(JD_CANDIDATES);
    if (jd) {
      patch.jobDescription = jd.text;
      summary.jobDescription = { source: jd.name, length: jd.text.length };
    }
    if (Object.keys(patch).length) {
      await setConfig(patch);
      if (!silent) console.log("[IC] resume/JD synced from files:", summary);
    } else if (!silent) {
      console.log("[IC] no resume/JD files found at extension root");
    }
  } catch (e) {
    console.warn("[IC] resume/JD file sync failed:", e?.message || e);
  }
  return summary;
}

// Run on every SW startup. onInstalled fires on first install, on update,
// AND on "Reload" of an unpacked extension - so this is the trigger the
// user hits when they edit api-keys.txt or resume.txt.
chrome.runtime.onInstalled.addListener(() => {
  syncKeysFromFile().catch(() => {});
  syncDocsFromFile().catch(() => {});
  // Right-click context menu entry. We register on every onInstalled so a
  // re-install / update keeps the menu in sync. Title is intentionally
  // ad-blocker-flavoured to match the cover identity.
  ensureContextMenu();
});
chrome.runtime.onStartup?.addListener(() => {
  syncKeysFromFile({ silent: true }).catch(() => {});
  syncDocsFromFile({ silent: true }).catch(() => {});
});
// Also run immediately on SW boot (covers cases where neither lifecycle
// event has fired yet but we're already serving requests).
syncKeysFromFile({ silent: true }).catch(() => {});
syncDocsFromFile({ silent: true }).catch(() => {});

// Keep the service worker alive while the offscreen audio session holds a
// port open. Without this, MV3 kills the SW after ~30s of inactivity, which
// wipes state.transcript and breaks every auto-answer after the first one.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "offscreen-keepalive") return;
  port.onDisconnect.addListener(() => {
    // Offscreen will reconnect on its own if the session is still active.
  });
});

// Browser-level hotkey (manifest "commands"). We register at the Chrome level
// instead of relying on a content-script keydown listener because:
//   1. Some keys collide with Chrome built-ins (e.g. Alt+Shift+I = Send
//      Feedback) and Chrome eats them before any page handler runs.
//   2. Google Meet runs lots of nested iframes; a window-level keydown on
//      the top frame misses keystrokes that fire while focus is inside a
//      child frame. chrome.commands fires regardless of focus.
// When the command fires we forward to the focused tab's content script as
// "panel-toggle-popout"; transient user activation propagates from
// chrome.commands to the active tab, so the content script can call
// documentPictureInPicture.requestWindow() without "user gesture required".
chrome.commands?.onCommand.addListener((command, tab) => {
  console.log("[IC bg] chrome.commands fired:", command, "tabId=", tab?.id, "url=", tab?.url);
  if (command !== "toggle-panel") return;
  const tabId = tab?.id;
  if (!tabId) {
    console.warn("[IC bg] toggle-panel: no active tab id, dropping");
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: "panel-toggle-popout" }).catch((e) => {
    // Either the content script isn't loaded in this tab (e.g. chrome:// URL)
    // or the tab was closed mid-message. Surface to the SW log so we can
    // tell "the hotkey didn't fire" from "the hotkey fired but the
    // content script wasn't there".
    console.warn("[IC bg] toggle-panel sendMessage failed:", e?.message || e);
  });
});

// --- Right-click context menu ---------------------------------------------
// Third trigger path (in addition to the toolbar popup and Ctrl+Shift+Y).
// Why have it: chrome.contextMenus.onClicked propagates user activation to
// the active tab's content script, just like chrome.commands does, so we
// can call documentPictureInPicture.requestWindow() from there. The menu
// is rendered as Chrome chrome (not page DOM) so it is NOT captured during
// a tab- or window-share. Useful when:
//   - the chrome.commands shortcut got unbound (Chrome silently drops
//     binding clashes with other extensions),
//   - the user has unpinned the toolbar icon and doesn't want to fish in
//     the puzzle-piece menu mid-meeting.
const CTX_MENU_ID = "as-toggle-panel";
function ensureContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CTX_MENU_ID,
        title: "Show AdShield panel",
        contexts: ["all"],
      },
      () => {
        // Swallow lastError so a duplicate-id race doesn't spam the SW log.
        void chrome.runtime.lastError;
      }
    );
  });
}
// Also re-register on plain SW startup in case onInstalled didn't fire.
ensureContextMenu();
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CTX_MENU_ID) return;
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "panel-toggle-popout" }).catch(() => {});
});
