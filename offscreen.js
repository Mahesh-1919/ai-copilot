// Offscreen audio capture.
//
// Two branches based on cfg.sttProvider:
//
//   1) "assemblyai": stream PCM16 frames straight to AssemblyAI Universal-3 Pro
//      Streaming over a WebSocket. Server handles VAD/turn detection. Partials
//      and finals are forwarded to the background.
//
//   2) "groq-whisper" / "openai-whisper": legacy chunk-based path - local RMS
//      VAD slices the stream into ~1.5-15s WAV blobs and POSTs each one to a
//      Whisper endpoint, in strict audio-time order.
//
// STT lives here (not in background) because chrome.runtime.sendMessage is
// JSON-only and would mangle a raw audio ArrayBuffer in transit.
//
// Audio path uses an AudioWorklet (replaces the deprecated ScriptProcessorNode):
//   sourceNode --(connect)--> AudioWorkletNode("pcm-tap") --port.onmessage--> handleFrame()

import { float32ToWavBlob, mergeFloat32 } from "./lib/wav.js";
import { transcribe } from "./lib/transcribers.js";
import { AaiStreamingSession } from "./lib/aaiStreaming.js";

const TARGET_SAMPLE_RATE = 16000;
const FRAMES_PER_POST    = 4096;        // ~256 ms at 16 kHz
const CHUNK_PEAK_SKIP    = 0.02;
const WORKLET_URL        = chrome.runtime.getURL("audio-worklet.js");

let audioCtx     = null;
let sourceNode   = null;
let workletNode  = null;
let workletSink  = null;     // muted gain -> destination, keeps the worklet in an active sub-graph
let mediaStream  = null;
let cfg          = null;

// Long-lived port to the background service worker. Holding this open keeps
// the SW alive across the whole session - without it MV3 kills the SW after
// ~30s of inactivity, which wipes state.transcript and breaks subsequent
// auto-answers.
let keepalivePort = null;

// Frame dispatch - set by startAssemblyAI() or startWhisperVad().
let frameSink    = null;

// ---- Whisper VAD chunker state ----
let buffer = [];
let silenceStart = null;
let chunkStart = 0;
let speakingDetected = false;

// Serialize Whisper uploads so transcripts arrive in audio-time order.
let whisperQueue = Promise.resolve();

// ---- AssemblyAI streaming state ----
let aaiSession = null;

function resetVad() {
  buffer = [];
  silenceStart = null;
  chunkStart = performance.now();
  speakingDetected = false;
}

async function setupAudioGraph(streamId) {
  console.log("[IC offscreen] getUserMedia(tab streamId)");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (e) {
    // Surface the real Chrome error.  Common ones on the second Start:
    //   "Invalid stream id"           - streamId expired or already consumed
    //   "Could not start audio source" - previous capture not fully released
    //   "NotAllowedError"             - permissions revoked
    throw new Error(`tabCapture getUserMedia failed: ${e?.name || ""} ${e?.message || e}`);
  }

  console.log("[IC offscreen] creating AudioContext");
  audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  if (audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch { /* non-fatal */ }
  }

  console.log("[IC offscreen] addModule(audio-worklet.js)");
  await audioCtx.audioWorklet.addModule(WORKLET_URL);

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  // Pass-through so the user still hears the call audio.
  sourceNode.connect(audioCtx.destination);

  // numberOfOutputs: 1 (and a silent connection through to destination) is the
  // safe pattern. Chrome only schedules process() on nodes that are part of an
  // active sub-graph reaching the audio destination. With numberOfOutputs: 0
  // the node is technically valid but Chrome can skip processing it - which
  // would silently break transcription.
  workletNode = new AudioWorkletNode(audioCtx, "pcm-tap", {
    numberOfInputs:  1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { framesPerPost: FRAMES_PER_POST },
  });
  workletNode.port.onmessage = (e) => {
    const frame = e.data;
    if (frame instanceof Float32Array && frameSink) frameSink(frame);
  };

  workletSink = audioCtx.createGain();
  workletSink.gain.value = 0;             // we don't want to hear the tap, just keep the node live
  sourceNode.connect(workletNode);
  workletNode.connect(workletSink).connect(audioCtx.destination);
}

async function startAssemblyAI({ token }) {
  aaiSession = new AaiStreamingSession({
    token,
    sampleRate: TARGET_SAMPLE_RATE,
    speechModel: cfg.sttModel || "u3-rt-pro",
    interruptionDelay: cfg.aaiInterruptionDelay,
    minTurnSilence: cfg.aaiMinTurnSilence,
    maxTurnSilence: cfg.aaiMaxTurnSilence,
    keytermsPrompt: cfg.keytermsPrompt,
    onPartial: (text) => {
      chrome.runtime.sendMessage({ type: "transcript-partial", text }).catch(() => {});
    },
    onFinal: (text) => {
      chrome.runtime.sendMessage({ type: "transcript-text", text }).catch(() => {});
    },
    onError: (err) => {
      chrome.runtime.sendMessage({ type: "error", error: `AssemblyAI: ${err.message || err}` }).catch(() => {});
    },
    onClose: ({ code, reason }) => {
      if (code !== 1000 && code !== 1005) {
        chrome.runtime.sendMessage({
          type: "error",
          error: `AssemblyAI WS closed (code ${code}${reason ? `: ${reason}` : ""})`,
        }).catch(() => {});
      }
    },
  });
  await aaiSession.connect();

  frameSink = (frame) => {
    if (!aaiSession) return;
    aaiSession.sendAudio(frame);
  };
}

function startWhisperVad() {
  resetVad();
  frameSink = (frame) => {
    buffer.push(frame);

    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / frame.length);

    const now = performance.now();
    const elapsed = now - chunkStart;
    const isSilent = rms < (cfg.silenceRms ?? 0.012);

    if (!isSilent) {
      speakingDetected = true;
      silenceStart = null;
    } else if (silenceStart === null) {
      silenceStart = now;
    }

    const silenceMs  = cfg.silenceMs  ?? 1200;
    const maxChunkMs = cfg.maxChunkMs ?? 15000;
    const minChunkMs = cfg.minChunkMs ?? 1200;

    if (speakingDetected && silenceStart !== null && now - silenceStart > silenceMs && elapsed > minChunkMs) {
      enqueueWhisperChunk();
    } else if (elapsed > maxChunkMs && speakingDetected) {
      enqueueWhisperChunk();
    } else if (elapsed > 30000 && !speakingDetected) {
      buffer = [];
      chunkStart = now;
    }
  };
}

// Detach the current buffer synchronously, then queue its upload behind any
// previous in-flight upload. Guarantees finalized transcripts arrive in
// audio-time order regardless of variable Whisper latency.
function enqueueWhisperChunk() {
  if (!buffer.length) return;
  const merged = mergeFloat32(buffer);
  resetVad();

  let peak = 0;
  for (let i = 0; i < merged.length; i++) {
    const a = Math.abs(merged[i]);
    if (a > peak) peak = a;
  }
  if (peak < CHUNK_PEAK_SKIP) return;

  whisperQueue = whisperQueue.then(() => uploadWhisperChunk(merged));
}

async function uploadWhisperChunk(merged) {
  const wav = float32ToWavBlob(merged, TARGET_SAMPLE_RATE);
  try {
    const { text } = await transcribe(cfg, wav);
    if (text) {
      await chrome.runtime.sendMessage({ type: "transcript-text", text });
    }
  } catch (e) {
    chrome.runtime.sendMessage({
      type: "error",
      error: `STT failed: ${e?.message || e}`,
    }).catch(() => {});
  }
}

// Keep the background service worker alive for the whole session.
// Chrome historically capped a single port's keepalive at 5 minutes; we work
// around that by reconnecting whenever the port disconnects on its own.
function openKeepalive() {
  if (keepalivePort) return;
  try {
    keepalivePort = chrome.runtime.connect({ name: "offscreen-keepalive" });
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
      // If we are still capturing, reopen on the next tick.
      if (frameSink) setTimeout(openKeepalive, 0);
    });
  } catch {
    keepalivePort = null;
  }
}

function closeKeepalive() {
  if (!keepalivePort) return;
  try { keepalivePort.disconnect(); } catch {}
  keepalivePort = null;
}

async function startCapture({ streamId, cfg: _cfg, aaiToken }) {
  console.log("[IC offscreen] startCapture", { sttProvider: _cfg?.sttProvider, hasStreamId: !!streamId });
  cfg = _cfg;
  openKeepalive();
  await setupAudioGraph(streamId);

  // If the post-setup branch fails, tear down the audio graph so we don't
  // leak a tap on the meeting tab's audio.
  try {
    if (cfg.sttProvider === "assemblyai") {
      if (!aaiToken) throw new Error("AssemblyAI session token missing.");
      console.log("[IC offscreen] connecting to AssemblyAI");
      await startAssemblyAI({ token: aaiToken });
    } else {
      console.log("[IC offscreen] starting Whisper VAD chunker");
      startWhisperVad();
    }
    console.log("[IC offscreen] startCapture OK");
  } catch (e) {
    console.error("[IC offscreen] startCapture branch failed:", e);
    try { await stopCapture(); } catch { /* best effort */ }
    throw e;
  }
}

async function stopCapture() {
  // Stop the producer first - no more frames after this point.
  frameSink = null;
  if (workletNode) {
    try { workletNode.port.onmessage = null; } catch {}
    try { workletNode.port.close();           } catch {}
  }

  // Close AssemblyAI cleanly while audio nodes are still alive.
  if (aaiSession) {
    try { await aaiSession.terminate(); } catch {}
    aaiSession = null;
  }

  // Drain any pending Whisper uploads so trailing transcripts still arrive.
  try { await whisperQueue; } catch {}
  whisperQueue = Promise.resolve();

  try { workletNode?.disconnect(); } catch {}
  try { workletSink?.disconnect(); } catch {}
  try { sourceNode?.disconnect();   } catch {}
  try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { await audioCtx?.close(); } catch {}

  audioCtx     = null;
  sourceNode   = null;
  workletNode  = null;
  workletSink  = null;
  mediaStream  = null;
  buffer       = [];
  silenceStart = null;
  speakingDetected = false;

  closeKeepalive();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  (async () => {
    try {
      if (msg.type === "start-capture") {
        await startCapture({ streamId: msg.streamId, cfg: msg.cfg, aaiToken: msg.aaiToken });
        sendResponse({ ok: true });
      } else if (msg.type === "stop-capture") {
        await stopCapture();
        sendResponse({ ok: true });
      } else if (msg.type === "force-endpoint") {
        aaiSession?.forceEndpoint();
        sendResponse({ ok: true });
      } else if (msg.type === "update-aai-config") {
        aaiSession?.updateConfiguration(msg.patch || {});
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown offscreen message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
