# AdShield Desktop ("System Monitor")

Electron interview copilot. A frameless, always-on-top window, excluded from screen capture, listens to speaker audio, transcribes it with Groq Whisper and streams answers from an LLM.

- **Hidden from screen share.** `setContentProtection(true)` is set on Windows 10 2004+ and macOS.
- **Speaker audio only.** System loopback via `getDisplayMedia`; the microphone is never captured.
- **Auto-answer.** Debounced, with heuristics that wait for the speaker to finish the question.
- **Analyse Screen.** A vision model transcribes the screenshot, then a reasoning model solves it.
- **Provider fallback** across Cerebras, Gemini and OpenRouter.
- **Tray app.** No taskbar entry, starts hidden at Windows login, and `Alt+.` shows or hides it.

See [docs/usage.md](docs/usage.md) for day-to-day usage (hotkeys, tray, transparency).

## Quick start

```bash
cd desktop
npm install
npm start
```

Requires Node 20+. `npm start` builds into `dist/` and then launches Electron.

## Configuration

The app reads these files and **reloads them every time you press Start**:

| File | Purpose |
|------|---------|
| `api-keys.json` | Provider keys (required) |
| `resume.txt` / `resume.md` | Used for behavioural / experience answers |
| `job-description.txt` / `jd.txt` / `jd.md` / `job-description.md` | Target role. Any text after an "Interview Preparation Guide" heading is treated as a high-priority HR guide |

Where they're looked up, first match wins:

- **Development:** `desktop/`, then the repository root.
- **Packaged build:** the folder containing the `.exe`, then `%APPDATA%\System Monitor\`, then files bundled at build time (any of the files above present in `desktop/` or the repo root when you run `npm run dist`).

`api-keys.json`: each value can be a string or an array.

```json
{
  "groq":       ["gsk_..."],
  "cerebras":   ["csk_answers", "csk_screen", "csk_fallback"],
  "gemini":     ["AIza..."],
  "openrouter": ["sk-or-v1-..."]
}
```

| Key | Used for |
|-----|----------|
| `groq[0]` | Whisper speech-to-text (**required** for audio) |
| `cerebras[0]` | Primary answers (`gpt-oss-120b`) |
| `cerebras[1]` | Analyse Screen: vision (`gemma-4-31b`) and solving |
| `cerebras[2]` | Fallback for both of the above |
| `gemini[0]`, `openrouter[0]` | Last-resort fallbacks for everything |

Model IDs and the fallback order live in [src/main/llm/candidates.ts](src/main/llm/candidates.ts).

## Scripts

| Command | What it does |
|---------|--------------|
| `npm start` | Build and run |
| `npm run dev` | Build and run with DevTools and debug logging |
| `npm run build:watch` | Rebuild on change. Hide and show the window (`Alt+.`) to relaunch on the new build |
| `npm run typecheck` | `tsc` for the main/preload and renderer projects |
| `npm run lint` | ESLint (typescript-eslint) |
| `npm test` | Vitest unit tests |
| `npm run check` | All three of the above |
| `npm run dist` / `dist:portable` | Checks, minified build, then a Windows build with electron-builder into `release/` |

Set `LOG_LEVEL=debug|info|warn|error` to control main-process logging (default `info`, or `debug` with `--dev`).

## Architecture

```
desktop/
├── src/
│   ├── shared/
│   │   └── ipc.ts                 IPC channel names + payload types (single source of truth)
│   ├── main/                      Electron main process (Node)
│   │   ├── index.ts               App lifecycle, single-instance lock, wiring
│   │   ├── app-window.ts          BrowserWindow (content protection, sandbox, hide-to-tray)
│   │   ├── tray.ts                Tray icon + menu
│   │   ├── shortcuts.ts           Alt+. toggle, Ctrl+←/→ widen
│   │   ├── media-permissions.ts   Loopback-only display media, screen capture
│   │   ├── ipc-handlers.ts        Validated ipcMain handlers → CopilotSession
│   │   ├── dev-reload.ts          Relaunch on new build (dev only)
│   │   ├── logger.ts
│   │   ├── services/
│   │   │   ├── copilot-session.ts Session state, auto-answer, answer + screen pipelines
│   │   │   ├── config.ts          Finds and validates api-keys / resume / JD
│   │   │   ├── prompts.ts         All prompt text
│   │   │   ├── question-heuristics.ts  "Is the question finished?" + Whisper noise filter
│   │   │   └── transcription.ts   Groq Whisper client
│   │   └── llm/
│   │       ├── providers.ts       Provider factory
│   │       ├── openai-compatible.ts  Cerebras / Groq / OpenAI / OpenRouter streaming client
│   │       ├── gemini.ts          Gemini streaming client
│   │       ├── sse.ts             SSE reader + <think> filter
│   │       ├── candidates.ts      Model IDs and fallback order
│   │       └── errors.ts
│   ├── preload/
│   │   └── index.ts               contextBridge → window.electronAPI (typed)
│   └── renderer/                  UI (browser context, no Node)
│       ├── index.html, styles.css
│       ├── main.ts                App controller
│       ├── audio/                 Speaker capture, VAD, WAV encoding, AudioWorklet
│       ├── lib/markdown.ts        Escaping markdown renderer
│       └── ui/                    DOM lookup, timer, transparency controls
├── tests/                         Vitest unit tests
├── scripts/
│   ├── build.mjs                  esbuild bundler (main, preload, renderer, worklet)
│   └── windows/Start-SystemMonitor.vbs   Console-less launcher
└── docs/usage.md
```

Data flow: renderer audio → VAD → WAV → `audio:transcribe` IPC → Groq Whisper → transcript → debounced auto-answer → LLM stream → `answer:chunk` events → markdown render.

### Security model

- The renderer runs with `sandbox`, `contextIsolation` and no Node integration, under a strict CSP. Navigation and new windows are blocked.
- API keys stay in the main process. The renderer only ever receives a summary of what's configured.
- Every IPC argument is type- and size-checked before it reaches the session.
- Model output is HTML-escaped before markdown is applied.
- The Gemini key is sent in a header, not the URL.
