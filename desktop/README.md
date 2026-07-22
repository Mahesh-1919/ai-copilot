# AdShield Desktop

Electron-based interview copilot with **screen-share invisibility** via `setContentProtection`.

## Key Features

- ✅ **Invisible during screen share** - uses Electron's `setContentProtection(true)`
- ✅ **Always-on-top** floating window with stealth "System Monitor" title
- ✅ **Works across ALL apps** - not limited to browser tabs
- ✅ **Real-time LLM** (Groq, OpenRouter, OpenAI)
- ✅ **Automatic audio capture** from system audio via screen share API
- ✅ **Speech-to-text** (Groq Whisper) with smart VAD
- ✅ **Manual text input** for testing and in-person interviews

## Quick Start

### 1. Install dependencies

```bash
cd desktop
npm install
```

### 2. Configure API keys

Make sure you have `api-keys.json` in the **parent folder** (repo root):

```json
{
  "groq": ["gsk_YOUR_KEY_HERE"],
  "openai": ["sk-YOUR_KEY_HERE"],
  "openrouter": ["sk-or-v1-YOUR_KEY_HERE"]
}
```

### 3. Run the app

```bash
npm start
```

Or with DevTools for debugging:

```bash
npm run dev
```

## How to Use

### For Live Calls/Interviews:

1. **Start the app** - Window titled "System Monitor" appears (always on top)
2. **Join your interview** (Google Meet, Zoom, Teams, phone, etc.)
3. **Click "Start"** in the System Monitor app
4. **Grant screen share permission** - When prompted, select:
   - "Entire Screen" OR
   - The specific window/tab with your interview audio
   - Click "Share"
   - ⚠️ This is just to access system audio - the app won't actually share your screen
5. **Audio capture begins** - The app now listens to all system audio
6. **Automatic transcription** - Interviewer's questions appear in the transcript
7. **Click "Answer Question"** - Get LLM-generated answers in real-time
8. **Click "Pause"** anytime - Stops audio capture while you type code (interviewer's words won't interfere)
9. **Click "Resume"** - Restarts audio capture
10. **Click "Close"** - Ends session and hides window (Alt+. to reopen)

### For Manual Input (Testing):

1. **Start the app** and click "Start"
2. **Type questions** in the "Manual Input" box
3. **Press Enter** to send
4. **Click "Answer Question"** to get response

### Vision Mode (Screen Analysis):

1. **Click "Analyse Screen"** - Captures your screen
2. **LLM analyzes** visible code/questions
3. **Provides direct solutions** (not just descriptions)

## Screen-Share Invisibility Test

1. Open the app
2. Start Google Meet / Zoom / Teams
3. Share your **entire screen**
4. Look at the share preview - the System Monitor window should be **invisible or black**
5. ✅ If invisible: content protection works
6. ❌ If visible: your Windows version may not support it (requires Windows 10 1703+)

## Current Limitations

### Audio Capture
**Status:** Manual input only

**Why:** System audio capture on Windows requires:
- Virtual audio cable (VB-Audio, etc.)
- OR Windows Audio Session API integration
- OR using Chrome extension's `tabCapture` (which this doesn't have)

**Workaround:** Use the Chrome extension (`../extension/`) for auto-audio interviews. Use this Electron app for:
- In-person interviews (type the question)
- Practice sessions with manual Q&A
- Cross-app visibility needs

**Future:** Will add mic capture + optional virtual cable support

## Configuration

The app reads from the **root folder** (same as Chrome extension):

- `../api-keys.json` or `../api-keys.txt` - API keys
- `../resume.txt` or `../resume.md` - Your resume
- `../job-description.txt` / `../jd.txt` / `../jd.md` - Target job

Same files, no duplication!

## Development Status

- [x] Basic Electron window with setContentProtection
- [x] Session controls (Start/Stop/Pause/Resume)
- [x] Manual text input
- [x] LLM streaming (Groq, OpenAI, OpenRouter)
- [x] Config loading (API keys, resume, JD)
- [x] Transcript display
- [x] Answer rendering
- [ ] System audio capture (pending Windows audio loopback)
- [ ] STT (Groq Whisper, AssemblyAI, OpenAI Whisper)
- [ ] Vision analysis (screenshot + vision model)
- [ ] Markdown code block rendering

## Architecture

```
desktop/
├── main.js              # Main process (window + IPC)
├── backend.js           # Session state + LLM logic
├── lib-providers.js     # LLM providers (Groq, OpenAI, OpenRouter)
├── preload.js           # Context bridge (renderer ↔ main)
├── renderer/
│   ├── index.html       # UI
│   ├── app.js           # Renderer logic
│   └── styles.css       # Dark UI theme
└── package.json
```

## Recommended Workflow

**For browser-based interviews (Google Meet, Zoom Web):**
→ Use the **Chrome extension** (`../extension/`) - full auto-audio + STT + LLM

**For multi-app interviews (browser + VSCode + coding platforms):**
→ Use this **Electron app** - invisible across all apps, manual input

**For in-person / phone interviews:**
→ Use this **Electron app** - type questions as they're asked
