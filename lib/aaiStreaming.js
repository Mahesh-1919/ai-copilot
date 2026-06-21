// AssemblyAI Universal-3 Pro Streaming adapter.
//
// MV3 browser context: extension WebSockets cannot set custom headers, so we
// mint a single-use temp token via fetch() (which CAN set Authorization) and
// pass it as a `?token=` query parameter on the WS URL.

const TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const WS_URL    = "wss://streaming.assemblyai.com/v3/ws";

const SAMPLE_RATE_DEFAULT = 16000;

export async function mintStreamingToken(apiKey, expiresInSeconds = 600) {
  if (!apiKey) throw new Error("AssemblyAI API key missing.");
  const url = `${TOKEN_URL}?expires_in_seconds=${encodeURIComponent(expiresInSeconds)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`AssemblyAI token mint failed (HTTP ${res.status}): ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  if (!j.token) throw new Error("AssemblyAI token mint returned no token.");
  return j.token;
}

// Float32 [-1, 1] -> Int16 little-endian PCM. Returns ArrayBuffer ready for ws.send().
export function float32ToInt16Buffer(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function buildConnectionUrl({ token, sampleRate, speechModel, interruptionDelay, minTurnSilence, maxTurnSilence }) {
  const params = new URLSearchParams({
    sample_rate:        String(sampleRate ?? SAMPLE_RATE_DEFAULT),
    speech_model:       speechModel || "u3-rt-pro",
    encoding:           "pcm_s16le",
    interruption_delay: String(interruptionDelay ?? 200),
    min_turn_silence:   String(minTurnSilence ?? 100),
    max_turn_silence:   String(maxTurnSilence ?? 1000),
    token,
  });
  return `${WS_URL}?${params.toString()}`;
}

// keyterms_prompt is per-session config sent right after Begin via UpdateConfiguration.
function parseKeyterms(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
}

/**
 * Session wrapper. Caller drives audio via `sendAudio(float32Frame)` for each
 * ScriptProcessor onaudioprocess callback. All callbacks are optional.
 */
export class AaiStreamingSession {
  constructor({
    token,
    sampleRate = SAMPLE_RATE_DEFAULT,
    speechModel = "u3-rt-pro",
    interruptionDelay = 200,
    minTurnSilence = 100,
    maxTurnSilence = 1000,
    keytermsPrompt = "",
    onBegin, onPartial, onFinal, onError, onClose,
  }) {
    this.token = token;
    this.sampleRate = sampleRate;
    this.speechModel = speechModel;
    this.interruptionDelay = interruptionDelay;
    this.minTurnSilence = minTurnSilence;
    this.maxTurnSilence = maxTurnSilence;
    this.keyterms = parseKeyterms(keytermsPrompt);
    this.onBegin   = onBegin   || (() => {});
    this.onPartial = onPartial || (() => {});
    this.onFinal   = onFinal   || (() => {});
    this.onError   = onError   || (() => {});
    this.onClose   = onClose   || (() => {});
    this.ws = null;
    this.opened = false;
    this.terminated = false;
  }

  async connect() {
    const url = buildConnectionUrl({
      token: this.token,
      sampleRate: this.sampleRate,
      speechModel: this.speechModel,
      interruptionDelay: this.interruptionDelay,
      minTurnSilence: this.minTurnSilence,
      maxTurnSilence: this.maxTurnSilence,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this.opened = true;
        if (this.keyterms.length) {
          try {
            ws.send(JSON.stringify({
              type: "UpdateConfiguration",
              keyterms_prompt: this.keyterms,
            }));
          } catch { /* non-fatal */ }
        }
        if (!settled) { settled = true; resolve(); }
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
        catch { return; }
        switch (msg.type) {
          case "Begin":
            this.onBegin(msg);
            break;
          case "Turn": {
            const text = (msg.transcript || "").trim();
            if (!text) break;
            if (msg.end_of_turn) this.onFinal(text, msg);
            else this.onPartial(text, msg);
            break;
          }
          case "Termination":
            this.terminated = true;
            break;
          case "Error":
            this.onError(new Error(msg.error || "AssemblyAI streaming error"));
            break;
        }
      };

      ws.onerror = () => {
        const err = new Error("AssemblyAI WebSocket error");
        if (!settled) { settled = true; reject(err); }
        else this.onError(err);
      };

      ws.onclose = (ev) => {
        this.opened = false;
        this.onClose({ code: ev.code, reason: ev.reason });
        if (!settled) {
          settled = true;
          reject(new Error(`AssemblyAI WS closed before open (code ${ev.code})`));
        }
      };
    });
  }

  // Send one ~50–1000ms PCM frame. Float32 input is converted to Int16.
  sendAudio(float32) {
    if (!this.opened || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(float32ToInt16Buffer(float32));
  }

  updateConfiguration(patch) {
    if (!this.opened) return;
    try { this.ws.send(JSON.stringify({ type: "UpdateConfiguration", ...patch })); }
    catch { /* non-fatal */ }
  }

  forceEndpoint() {
    if (!this.opened) return;
    try { this.ws.send(JSON.stringify({ type: "ForceEndpoint" })); }
    catch { /* non-fatal */ }
  }

  // Always call this on shutdown — abandoned sessions accrue charges to the 3-h cap.
  async terminate() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "Terminate" }));
      }
    } catch { /* ignore */ }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.opened = false;
  }
}

// Used by Options "Test connection" — succeeds iff the key can mint a token.
export async function pingAssemblyAI(apiKey) {
  const t = await mintStreamingToken(apiKey, 60);
  return `token minted (len=${t.length})`;
}
