# AdShield - Interview Copilot

Real-time AI interview assistant available in **two versions**:

1. **Chrome Extension** (`extension/`) - Browser-based with auto-audio
2. **Electron Desktop** (`desktop/`) - Native app with screen-share invisibility

## 🎯 Which Version Should I Use?

| Feature | Chrome Extension | Electron Desktop |
|---------|------------------|------------------|
| **Auto audio capture** | ✅ Yes (tab audio) | ⏳ Manual input only* |
| **Speech-to-text** | ✅ Groq/OpenAI/AssemblyAI | ⏳ Coming soon |
| **LLM answers** | ✅ Yes | ✅ Yes |
| **Screen-share invisibility** | ⚠️ Tab-only | ✅ **Always** (Windows 10+) |
| **Works across apps** | ❌ Chrome only | ✅ VSCode, Programiz, etc. |
| **Setup** | Easy (load unpacked) | Medium (npm install) |
| **Stealth** | "AdShield Lite" | "System Monitor" |

\*System audio on Windows requires virtual audio cable or API integration (pending)

### Quick Recommendations:

- **Browser-only interviews** (Google Meet, Zoom Web) → Use **Chrome Extension**
- **Multi-app interviews** (browser + IDE + coding platforms) → Use **Electron Desktop** (type questions manually)
- **In-person / phone interviews** → Use **Electron Desktop** (type as they ask)

---

## Chrome Extension Setup

See [extension/README.md](extension/README.md) for full docs.

**Quick start:**
```bash
1. Open chrome://extensions
2. Enable Developer mode
3. Load unpacked → select /extension/ folder
4. Add API keys in extension options
5. Start a meeting → Click extension → Start session
```

**Features:**
- Auto-captures tab audio (Google Meet, Zoom Web, Teams Web)
- Real-time STT (Groq Whisper, OpenAI Whisper, AssemblyAI)
- Streaming LLM answers
- Invisible when sharing *tabs* (not entire screen)

---

## Electron Desktop Setup

See [desktop/README.md](desktop/README.md) for full docs.

**Quick start:**
```bash
cd desktop
npm install
npm start
```

**How to use:**
1. Window titled "System Monitor" appears (stealth, always on top)
2. Click "Start"
3. Type interview questions in the input box
4. Answers stream from LLM (Groq/OpenAI/OpenRouter)
5. Pause/Resume as needed

**Features:**
- Invisible during screen share (even full-screen share)
- Works across ANY app (not just browser)
- Manual text input → LLM answer
- Same config as extension (api-keys.json, resume.txt, jd.txt)

**Test invisibility:**
1. Start app
2. Open Zoom/Meet and share entire screen
3. App window should be invisible/black in preview ✅

---

## Shared Configuration

Both versions read from the **root folder**:

```
interview-copilot/
├── api-keys.json        ← Your API keys (gitignored)
├── resume.txt           ← Your resume (gitignored)
├── job-description.txt  ← Target JD (gitignored)
└── .gitignore           ← Protects secrets
```

**Create `api-keys.json`** — bare minimum required to run (audio capture → STT → LLM answer):

```json
{
  "groq":     ["gsk_YOUR_GROQ_KEY"],
  "cerebras": ["csk_YOUR_CEREBRAS_KEY"]
}
```

| Key | Required? | Used for |
|-----|-----------|----------|
| `groq`     | ✅ Yes | Whisper speech-to-text (transcription) |
| `cerebras` | ✅ Yes (at least `cerebras[0]`) | Primary LLM answers (`gpt-oss-120b`) |

Optional providers (add only if you want fallback / extra features):

```json
{
  "groq":     ["gsk_YOUR_GROQ_KEY"],
  "cerebras": ["csk_ANSWER_KEY", "csk_VISION_KEY", "csk_FALLBACK_KEY"],
  "gemini":     ["AIza_YOUR_KEY"],
  "openrouter": ["sk-or-v1_YOUR_KEY"],
  "openai":     ["sk_YOUR_KEY"]
}
```

- `cerebras[1]` → vision model (`gemma-4-31b`) for **Analyse Screen**
- `cerebras[2]`, `gemini`, `openrouter`, `openai` → answer fallbacks if the primary key rate-limits/fails

> Each value can be a single string or an array. Only `groq` + `cerebras[0]` are needed to start.

**Add your resume** to `resume.txt` and job description to `job-description.txt`.

Both apps auto-load these files on startup.

---

## Repository Structure

```
interview-copilot/
├── extension/          Chrome MV3 extension (full auto-audio)
│   ├── manifest.json
│   ├── background.js   Service worker (LLM, STT, state)
│   ├── content/        Panel UI
│   ├── lib/            Providers, transcribers, storage
│   └── offscreen.js    Audio capture (tabCapture)
│
├── desktop/            Electron app (screen-share invisible)
│   ├── main.js         Window + setContentProtection
│   ├── backend.js      Session + LLM logic
│   ├── lib-providers.js  LLM adapters
│   ├── renderer/       UI (HTML/CSS/JS)
│   └── package.json
│
├── shared/             Common code (copied from extension/lib)
│   └── lib/
│
├── api-keys.json       Your keys (gitignored)
├── resume.txt          Your resume (gitignored)
├── job-description.txt Your JD (gitignored)
└── .gitignore
```

---

## Development Status

### Chrome Extension ✅ Production Ready
- [x] Real-time tab audio capture
- [x] STT (AssemblyAI, Groq Whisper, OpenAI Whisper)
- [x] LLM streaming (Groq, OpenRouter, OpenAI, Anthropic, Gemini)
- [x] Multi-API-key rotation + fallback
- [x] Pause/Resume
- [x] Document Picture-in-Picture
- [x] Vision analysis (screenshot → vision model)
- [x] Markdown code rendering

### Electron Desktop ✅ Core Functional, Audio Pending
- [x] Window with setContentProtection (invisible during share)
- [x] Session controls (Start/Stop/Pause/Resume)
- [x] Manual text input
- [x] LLM streaming (Groq, OpenAI, OpenRouter)
- [x] Config loading (keys, resume, JD)
- [x] Stealth title ("System Monitor")
- [ ] Auto system audio capture (needs Windows loopback)
- [ ] STT integration
- [ ] Vision analysis
- [ ] Markdown code rendering

---

## Security & Ethics

**Secrets:**
- `api-keys.json`, `resume.txt`, `job-description.txt` are **gitignored**
- Never committed to repo
- Stay local on your machine

**Detectability:**
- Using AI in interviews violates most companies' policies
- These tools exist for:
  - Personal practice
  - Accessibility (live captions for fast speakers)
  - Post-interview notes
- **Use at your own risk**

**Chrome Extension:**
- Runs inside Chrome process (no separate "parakeet" exe)
- Named "AdShield Lite" to blend in
- Panel hidden when sharing tabs

**Electron App:**
- Named "System Monitor" (looks like diagnostic tool)
- `setContentProtection` makes it invisible during shares
- But shows in taskbar (hide taskbar or pin many apps to bury it)

---

## License

MIT - see individual README files for full disclaimers