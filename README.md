# AdShield Lite (BYOK Chrome Extension)

> Project codename was *Interview Copilot*; the user-visible extension name is **AdShield Lite**
> so it blends in next to other browser extensions in screen shares. Functionally unchanged.

A real-time AI interview copilot that lives **inside Chrome**, not as a separate
desktop process — so it doesn't show up as `parakeet`/`pmodule`/etc. in Task
Manager. You bring your own API key (Groq, Gemini, OpenAI, or any
OpenAI-compatible endpoint), and the extension streams audio from the meeting
tab → Whisper → your LLM, then prints answers into a separate Chrome window
that **is not captured when you share only the meeting tab**.

## Why this exists / what it fixes vs. Parakeet & Chiku AI

| Problem with Parakeet/Chiku | This extension |
|---|---|
| Separate desktop process shows up in Task Manager (`para`, `pmodule`, `Parakeet`, `AI`…). | Runs inside the Chrome process. There is no extra process name to grep. |
| Locked to their LLM choices (and they upcharge for "premium" models). | Use any provider/model. Default presets for **Groq**, **Gemini**, **OpenAI**, plus a "Custom OpenAI-compatible" mode (OpenRouter, Together, Fireworks, Ollama, vLLM…). |
| Subscription / credit lock-in, USD pricing. | Free. You pay your LLM/STT provider directly at cost. |
| Audio capture via mic only, sometimes loses the interviewer's voice. | Uses `chrome.tabCapture` — pulls audio *directly from the meeting tab* (Zoom Web, Meet, Teams Web, etc.). Reliable, no echo. |
| Single transcription engine, often slow. | Pluggable STT — defaults to **Groq Whisper Turbo** (sub-second), falls back to OpenAI Whisper, with VAD-based silence chunking so you don't pay for dead air. |
| Account required even to try. | No account. No telemetry. Settings stored in `chrome.storage.local`. |
| Overlay sometimes leaks during full-screen share. | Overlay is a **separate Chrome popup window**. When you share only the meeting *tab* (the normal way), the overlay is in a different window and is *not* in the share. You can drag it to a second monitor too. |
| Vendor decides the system prompt + persona. | You fully own the system prompt. Paste your resume + JD; answers come out in first-person, grounded to your actual experience. |

## Limitations / honest caveats

- This is a "developer mode" extension. You'll load it unpacked.
- If the user shares the **entire screen** (not just a tab), the overlay
  window will be visible. Always share the *tab*, not the screen.
- `tabCapture` only captures audio while the tab is alive. Don't close the
  meeting tab during the session.
- Audio is sent to your chosen STT provider, and questions are sent to your
  chosen LLM provider. There is no other server in between — but those
  providers see the audio/text. Pick providers you trust.
- Detectability: using AI assistance in interviews is against most companies'
  policies. This tool exists for personal practice, accessibility (e.g. live
  captioning of fast speakers), and post-call note generation. Use at your own
  risk.

## Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**, pick the `interview-copilot` folder.
4. Pin the extension to the toolbar (click the puzzle icon → pin).
5. Click the extension icon → **⚙ settings** (or open `chrome://extensions` →
   *Details* → *Extension options*).
6. Pick a provider, paste your API key, pick a model, paste your resume.
   Click **Test connection** — you should see `OK — provider replied: "pong"`.
7. Save.

### Recommended starter config

- **Provider:** Groq
- **Model:** `llama-3.3-70b-versatile` *(or `openai/gpt-oss-120b` for stronger reasoning)*
- **STT:** Groq Whisper, model `whisper-large-v3-turbo`
- One API key covers both chat and STT.
- Get a key at <https://console.groq.com/keys>.

Other providers:

- **OpenAI:** model `gpt-4o-mini` (cheap), `gpt-4.1` (smart), key at <https://platform.openai.com/api-keys>.
- **Gemini:** model `gemini-2.5-flash`, key at <https://aistudio.google.com/apikey>. Gemini doesn't ship a Whisper endpoint, so set STT provider to Groq or OpenAI.
- **OpenRouter / Together / Fireworks / Ollama:** pick *Custom OpenAI-compatible*, paste their base URL and a model slug.

## Use

1. Open your meeting in a **Chrome tab** (Meet, Zoom Web, Teams Web, Whereby, HackerRank, LeetCode…).
2. Click the extension icon → **Start session**.
3. A small **AdShield Lite** window pops up. Drag it to a corner / second monitor.
4. When asked to share your screen, **share only the meeting tab**, not the entire screen.
5. The interviewer's audio is transcribed live; an answer streams into the overlay within ~1 sec of them finishing.
6. You can also type a question directly into the overlay's input bar (useful for in-person interviews — point your phone's mic at the room and re-type the question, or use it for behavioral prep).
7. Click **Stop** in the popup when done.

## File layout

```
manifest.json           MV3 manifest
background.js           Service worker: routing + LLM streaming
offscreen.html/js       Audio capture (tabCapture → VAD → WAV chunks)
popup.html/js/css       Toolbar popup: start/stop
options.html/js/css     Settings page (provider, key, resume, prompt)
overlay.html/js/css     Floating Copilot window
lib/storage.js          chrome.storage wrapper + defaults
lib/providers.js        Groq / OpenAI / Gemini chat adapters
lib/transcribers.js     Whisper STT adapters
lib/wav.js              Float32 → 16-bit PCM WAV
icons/                  16/48/128 PNG icons
```

## How it works (technical)

1. **Popup** triggers `chrome.tabCapture.getMediaStreamId({targetTabId})` from a user-gesture context.
2. **Background service worker** spawns an **offscreen document** (MV3 requires this — service workers can't hold `MediaStream`s).
3. **Offscreen** calls `getUserMedia({audio: {mandatory: {chromeMediaSource:'tab', chromeMediaSourceId}}})`, routes audio back to `audioContext.destination` so the user still hears the call, and taps a `ScriptProcessorNode` for analysis.
4. Per-frame **RMS-based VAD** chunks the audio: a chunk ends when there's silence ≥ `silenceMs` *and* the chunk is at least `minChunkMs` long, or hits `maxChunkMs`.
5. Each chunk is encoded as a 16 kHz mono **WAV** and posted to the background.
6. Background calls **Whisper** (Groq or OpenAI), appends the transcript, and (if `autoAnswer` is on) debounces 500 ms before firing an LLM request.
7. LLM request streams via **SSE** (OpenAI/Groq) or `streamGenerateContent?alt=sse` (Gemini). Deltas are broadcast to the overlay window in real time. Any in-flight stream is cancellable via `AbortController` (Stop button or new question arriving).

## Tuning

If transcription fires too aggressively (e.g. on short "uh-huh"s), in Settings:

- Increase **Silence (ms) to end a chunk** to 1500–2000.
- Increase **Min chunk length** to 2000.
- Increase **Silence RMS threshold** slightly (e.g. 0.02 in a noisy room).

If answers feel slow:

- Use Groq with `llama-3.1-8b-instant` (fastest) or `llama-3.3-70b-versatile`.
- Use Groq Whisper Turbo for STT.
- Lower **Max chunk length** so chunks flush faster.

## License

MIT — do what you want, but read the "Limitations / honest caveats" section.
