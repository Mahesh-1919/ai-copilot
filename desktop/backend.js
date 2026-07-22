// Backend logic - state management, LLM streaming, STT coordination
// Similar to background.js from extension, but adapted for Electron

const fs = require('fs').promises;
const path = require('path');
const { createProvider, getVisionModel, LLMHttpError } = require('./lib-providers');

const DEBOUNCE_NORMAL_MS = 1000;
const DEBOUNCE_INCOMPLETE_MS = 2500;

// Single-token tails that strongly imply "another burst is coming"
const CONTINUATION_TAIL = new Set([
  "and", "or", "but", "so", "because", "since", "while", "when", "where",
  "if", "unless", "though", "although", "as", "than", "that", "which",
  "whether", "of", "to", "for", "with", "without", "by", "on", "in", "into",
  "at", "from", "about", "over", "under", "between", "through", "across",
  "after", "before", "during", "the", "a", "an", "this", "that", "these",
  "those", "your", "my", "our", "their", "his", "her", "is", "are", "was",
  "were", "be", "been", "being", "do", "does", "did", "have", "has", "had",
  "can", "could", "will", "would", "should", "shall", "may", "might", "must",
  "uh", "um", "ah", "er", "like", "well", "how"
]);

// Two-token tails that precede more content
const CONTINUATION_TWO = new Set([
  "you know", "kind of", "sort of", "i mean", "you see",
  "for example", "such as", "in other words", "as in",
  "let me", "going to", "want to", "need to", "have to",
  "how to", "how you", "implemented it"
]);

function looksIncomplete(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  // Terminal punctuation -> complete
  if (/[.!?][)\]"\u201d']?\s*$/.test(trimmed)) return false;
  // Trailing punctuation like comma, dash, colon -> incomplete
  if (/[,;:\u2014\-]\s*$/.test(trimmed)) return true;
  // Token inspect
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const last1 = tokens[tokens.length - 1];
  const last2 = tokens.slice(-2).join(" ");
  if (CONTINUATION_TAIL.has(last1)) return true;
  if (CONTINUATION_TWO.has(last2)) return true;
  return false;
}

const WHISPER_HALLUCINATIONS = new Set([
  "thank you", "thank you.", "thank you very much", "thank you very much.",
  "thank you thank you", "subtitles by", "subtitles by amara.org",
  "thanks for watching", "thanks for watching.", "bye", "bye."
]);

function isWhisperHallucination(text) {
  const normalized = (text || "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "");
  if (!normalized) return true;
  if (WHISPER_HALLUCINATIONS.has(normalized)) return true;
  if (/^(thank you\s*)+$/.test(normalized)) return true;
  if (/^(thanks\s*)+$/.test(normalized)) return true;
  if (/^subtitles by/i.test(normalized)) return true;
  return false;
}

function isValidQuestion(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  if (isWhisperHallucination(trimmed)) return false;

  // If ends with '?', always valid
  if (/\?\s*$/.test(trimmed)) return true;

  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Require at least 4 tokens unless explicitly punctuated
  if (tokens.length < 4) return false;

  // Exclude pure filler turns (e.g. "uh yeah okay so")
  const FILLERS = new Set(["uh", "um", "yeah", "okay", "ok", "so", "like", "right", "ah"]);
  const nonFillers = tokens.filter(t => !FILLERS.has(t));
  if (nonFillers.length < 3) return false;

  return true;
} const state = {
  active: false,
  transcript: [],
  history: [], // Multi-turn conversation memory: [{ question, answer }]
  livePartial: "",
  consumedTurnIdx: 0,
  currentAnswerAbort: null,
  keyHealth: {},
  paused: false,
  config: null,
};

class Backend {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.config = null;
  }

  // Send message to renderer
  send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  // Load configuration from root folder files
  async loadConfig() {
    try {
      const rootDir = path.join(__dirname, '..');

      // Try to load API keys
      let apiKeys = {};
      try {
        const keysPath = path.join(rootDir, 'api-keys.json');
        const keysData = await fs.readFile(keysPath, 'utf-8');
        apiKeys = JSON.parse(keysData);
      } catch (e) {
        console.log('[backend] No api-keys.json found, using defaults');
      }

      // Try to load resume
      let resume = '';
      for (const filename of ['resume.txt', 'resume.md']) {
        try {
          resume = await fs.readFile(path.join(rootDir, filename), 'utf-8');
          break;
        } catch { }
      }

      // Try to load job description
      let jobDescription = '';
      for (const filename of ['job-description.txt', 'jd.txt', 'jd.md', 'job-description.md']) {
        try {
          jobDescription = await fs.readFile(path.join(rootDir, filename), 'utf-8');
          break;
        } catch { }
      }

      // Get first available API key for each provider
      const getFirstKey = (arr) => {
        if (!arr) return null;
        if (typeof arr === 'string') return arr;
        if (Array.isArray(arr) && arr.length > 0) return arr[0];
        return null;
      };

      this.config = {
        apiKeys,
        resume,
        jobDescription,
        // Provider settings
        provider: 'groq',
        apiKey: getFirstKey(apiKeys.groq),
        model: 'llama-3.3-70b-versatile',
        sttProvider: 'groq',
        sttModel: 'whisper-large-v3-turbo',
        autoAnswer: true,
      };

      console.log('[backend] Config loaded:', {
        hasGroqKey: !!this.config.apiKey,
        resumeLength: resume.length,
        jdLength: jobDescription.length,
      });

      return this.config;
    } catch (error) {
      console.error('[backend] Error loading config:', error);
      throw error;
    }
  }

  buildSystemPrompt() {
    const { resume, jobDescription } = this.config;

    let prompt = [
      "Interview copilot: Generate ACCURATE, TECHNICAL answers the candidate will speak.",
      "",
      "FORMAT:",
      "Q: <question summary>",
      "A: **<topic>**",
      "- <sentence with **key terms** bold>",
      "- <sentence>",
      "- <sentence>",
      "",
      "CRITICAL RULES:",
      "1. ANSWER THE ACTUAL QUESTION. If asked 'architecture', explain components/structure. If asked 'how it works', explain the mechanism. If asked 'X vs Y', explain THE DIFFERENCE. If asked to 'DRAW', create ASCII diagram.",
      "2. BE TECHNICAL & SPECIFIC. Name actual components, algorithms, patterns. No vague 'provides flexibility' - say HOW and WHY.",
      "3. BE ACCURATE. If uncertain, explain based on the terms used. Never confidently state wrong info.",
      "4. CONVERSATIONAL but SUBSTANTIAL. Use 'So...', 'The way it works...' but pack real technical content.",
      "5. 3-5 bullets max, 15-25 words each. Bold 2-4 **technical terms** per bullet.",
      "",
      "QUESTION PATTERNS:",
      "",
      "'DRAW' / 'DIAGRAM' Questions:",
      "- Create ASCII diagram: Use ┌─┐ │ └─┘ for boxes, → ↓ for arrows",
      "- Show component names in boxes, data flow with arrows",
      "- Add brief explanation after diagram",
      "- Keep diagram simple and clear",
      "",
      "'X vs Y' COMPARISONS:",
      "- First bullet: THE KEY DIFFERENCE in technical terms",
      "- Don't define each separately, explain what distinguishes them",
      "- Example: 'The key difference is **Chains are linear** (A→B→C) while **LangGraph is a graph** with **conditional branches** and **loops**'",
      "",
      "'Architecture' / 'Components':",
      "- Name ACTUAL PARTS with their roles",
      "- Explain how they CONNECT/COMMUNICATE",
      "- Example: 'K8s has a **Control Plane** (**API Server**, **etcd**, **Scheduler**) managing **Worker Nodes** with **kubelet** and **kube-proxy**'",
      "",
      "'How does X work' / 'Explain X':",
      "- Bullet 1: 'So X is a **[what it is]** that **[what it does]**'",
      "- Bullet 2: 'The way it works is **[mechanism/process]**'",
      "- Bullet 3: 'You'd use this when **[use case]** - like **[specific example]**'",
      "",
      "'Difference between X and Y':",
      "- Focus on DISTINGUISHING FEATURES",
      "- When they're used (use cases)",
      "- Technical trade-offs",
      "",
      "CODING:",
      "- 'The approach is **[algorithm]** because **[why]**'",
      "- Clean code block",
      "- '**O(n) time**, **O(1) space** means **[explain impact]**'",
      "",
      "BEHAVIORAL:",
      "- '**[Project name]** - **[context in 1 line]**'",
      "- 'I **[specific actions]** to solve **[problem]**'",
      "- 'Result: **[measurable numbers]** - **[impact]**'",
      "",
      "RED FLAGS TO AVOID:",
      "❌ Generic: 'provides flexibility and scalability'",
      "❌ Wrong: Stating incorrect facts confidently",
      "❌ Off-topic: Answering 'what is X' when asked 'architecture of X'",
      "❌ No comparison: Defining A and B separately for 'A vs B' question",
      "❌ Vague: 'manages relationships' instead of 'uses a hash map to track node connections'",
    ].join("\n");

    if (resume) {
      prompt += `\n\n---\n\nCandidate resume:\n${resume.slice(0, 2000)}`;
    }

    if (jobDescription) {
      prompt += `\n\n---\n\nJob description:\n${jobDescription.slice(0, 1000)}`;
    }

    return prompt;
  }

  async saveConfig(config) {
    this.config = { ...this.config, ...config };
    return { ok: true };
  }

  async startSession() {
    // Always terminate any older session first (fast Start/Stop/Start must not error)
    if (state.active || state.paused || state.currentAnswerAbort || this._autoAnswerTimer) {
      console.log('[backend] Ending previous session before start');
      await this.stopSession();
    }

    // Always reload resume/JD/keys so file edits apply without full app restart
    await this.loadConfig();

    state.active = true;
    state.transcript = [];
    state.history = [];
    state.livePartial = "";
    state.consumedTurnIdx = 0;
    state.paused = false;
    if (this._autoAnswerTimer) {
      clearTimeout(this._autoAnswerTimer);
      this._autoAnswerTimer = null;
    }

    this.send('session-state', {
      active: true,
      paused: false,
      transcript: [],
      livePartial: "",
    });

    console.log('[backend] Session started (resume/JD reloaded)');
    return { ok: true };
  }

  async stopSession() {
    if (state.currentAnswerAbort) {
      state.currentAnswerAbort.abort();
    }
    if (this._autoAnswerTimer) {
      clearTimeout(this._autoAnswerTimer);
      this._autoAnswerTimer = null;
    }

    state.active = false;
    state.transcript = [];
    state.history = [];
    state.livePartial = "";
    state.consumedTurnIdx = 0;
    state.paused = false;

    this.send('session-state', {
      active: false,
      paused: false,
      transcript: [],
      livePartial: "",
    });

    console.log('[backend] Session stopped');
    return { ok: true };
  }

  async pauseSession() {
    state.paused = true;
    this.send('session-state', { paused: true });
    return { ok: true };
  }

  async resumeSession() {
    state.paused = false;
    this.send('session-state', { paused: false });
    return { ok: true };
  }

  scheduleAutoAnswer() {
    if (!this.config?.autoAnswer || state.paused || !state.active) return;

    const questionText = state.transcript.slice(state.consumedTurnIdx).join(' ').trim();
    if (!questionText) return;

    let waitMs = DEBOUNCE_NORMAL_MS;
    if (looksIncomplete(questionText)) {
      waitMs = DEBOUNCE_INCOMPLETE_MS;
      console.log(`[backend] Auto-answer delayed (${waitMs}ms) - question looks incomplete: "${questionText.slice(-30)}"`);
    } else {
      console.log(`[backend] Auto-answer scheduled (${waitMs}ms) for: "${questionText.slice(-30)}"`);
    }

    if (this._autoAnswerTimer) clearTimeout(this._autoAnswerTimer);

    this._autoAnswerTimer = setTimeout(() => {
      this._autoAnswerTimer = null;
      const currentQuestion = state.transcript.slice(state.consumedTurnIdx).join(' ').trim();
      if (!isValidQuestion(currentQuestion)) {
        console.log(`[backend] Auto-answer skipped - text does not meet minimum question threshold: "${currentQuestion}"`);
        return;
      }
      this.generateAnswer().catch((e) => {
        console.error('[backend] auto-answer failed:', e);
      });
    }, waitMs);
  }

  async addTranscript(text) {
    if (!state.active || state.paused) {
      return { ok: false };
    }

    state.transcript.push(text);
    this.send('transcript-update', {
      transcript: state.transcript,
      livePartial: state.livePartial,
    });

    if (this.config?.autoAnswer && !state.paused) {
      this.scheduleAutoAnswer();
    }

    return { ok: true };
  }

  async clearTranscript() {
    state.transcript = [];
    state.history = [];
    state.livePartial = "";
    state.consumedTurnIdx = 0;

    this.send('transcript-update', {
      transcript: [],
      livePartial: "",
    });

    return { ok: true };
  }

  getGroqFallbackKey(preferredIndex = 9) {
    const groqKeys = this.config?.apiKeys?.groq;
    if (Array.isArray(groqKeys) && groqKeys.length > 0) {
      const idx = Math.min(preferredIndex, groqKeys.length - 1);
      return groqKeys[idx];
    }
    return this.config?.apiKey;
  }

  async generateAnswer(override) {
    if (!state.active) {
      this.send('error', 'No active session');
      return { ok: false };
    }

    if (this._autoAnswerTimer) {
      clearTimeout(this._autoAnswerTimer);
      this._autoAnswerTimer = null;
    }

    // Abort any in-flight answer
    if (state.currentAnswerAbort) {
      state.currentAnswerAbort.abort();
    }

    const abortController = new AbortController();
    state.currentAnswerAbort = abortController;

    try {
      // Build the question from override string or unconsumed transcript
      let question = "";
      if (typeof override === 'string' && override.trim()) {
        question = override.trim();
      } else {
        question = state.transcript.slice(state.consumedTurnIdx).join(' ').trim();
      }

      if (!question) {
        this.send('error', 'No question to answer');
        return { ok: false };
      }

      // Check if we have API key
      if (!this.config || !this.config.apiKey) {
        this.send('error', 'No API key configured. Add api-keys.json in root folder.');
        return { ok: false };
      }

      console.log('[backend] Generating answer for:', question.substring(0, 100));

      // Create provider
      const provider = createProvider(this.config.provider, this.config.apiKey);

      // Build messages with conversation history for multi-turn context
      const messages = [
        { role: 'system', content: this.buildSystemPrompt() },
      ];

      // Attach recent Q&A history turns (last 3 turns max to keep low TTFT)
      const recentHistory = state.history.slice(-3);
      for (const turn of recentHistory) {
        messages.push({
          role: 'user',
          content: `Question: ${turn.question}`,
        });
        messages.push({
          role: 'assistant',
          content: `Answer Summary:\n${turn.answer.slice(0, 600)}`,
        });
      }

      // Add current user question
      messages.push({
        role: 'user',
        content: `Current question (answer ONLY this, considering conversation context above if referenced):\n"""${question}"""\n\nReply Q:/A: with 3-5 short bullets. Start immediately.`,
      });

      // Stream response with temperature 0.3
      try {
        const stream = provider.streamChat(messages, {
          model: this.config.model,
          temperature: 0.3,
          signal: abortController.signal,
        });

        let fullAnswer = "";
        for await (const chunk of stream) {
          fullAnswer += chunk;
          this.send('answer-chunk', chunk);
        }

        this.send('answer-done');

        // Save Q&A turn to history for multi-turn context
        if (question && fullAnswer) {
          state.history.push({
            question,
            answer: fullAnswer.trim()
          });
          if (state.history.length > 5) {
            state.history.shift();
          }
        }

        // Mark this question as consumed
        if (typeof override !== 'string') {
          state.consumedTurnIdx = state.transcript.length;
        }

        console.log('[backend] Answer complete (history updated, total turns:', state.history.length, ')');
        return { ok: true };

      } catch (err) {
        if (err.name === 'AbortError') throw err;

        // Fallback to 10th Groq API Key if OpenRouter / primary key hits 402 / quota error
        const groqFallbackKey = this.getGroqFallbackKey(9);
        if (groqFallbackKey && groqFallbackKey !== this.config.apiKey) {
          console.warn('[backend] Primary provider failed (402/quota). Falling back to 10th Groq API key...');
          this.send('answer-chunk', '\n\n*⚠️ Primary key limit. Switched to 10th Groq API key (llama-3.3-70b-versatile)...*\n\n');

          const fallbackProvider = createProvider('groq', groqFallbackKey);
          const fallbackStream = fallbackProvider.streamChat(messages, {
            model: 'llama-3.3-70b-versatile',
            temperature: 0.3,
            signal: abortController.signal,
          });

          let fullAnswer = "";
          for await (const chunk of fallbackStream) {
            fullAnswer += chunk;
            this.send('answer-chunk', chunk);
          }

          this.send('answer-done');

          if (question && fullAnswer) {
            state.history.push({ question, answer: fullAnswer.trim() });
            if (state.history.length > 5) state.history.shift();
          }

          if (typeof override !== 'string') {
            state.consumedTurnIdx = state.transcript.length;
          }

          console.log('[backend] Answer complete via Groq 10th key fallback');
          return { ok: true };
        }
        throw err;
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[backend] Answer generation aborted');
      } else {
        console.error('[backend] Error generating answer:', error);
        const message = error instanceof LLMHttpError
          ? error.message
          : error.message || 'Unknown error';
        this.send('error', message);
      }
      return { ok: false };
    } finally {
      state.currentAnswerAbort = null;
    }
  }

  async abortAnswer() {
    if (state.currentAnswerAbort) {
      state.currentAnswerAbort.abort();
      state.currentAnswerAbort = null;
    }
    return { ok: true };
  }

  async analyseScreen() {
    if (!state.active) {
      this.send('error', 'No active session');
      return { ok: false };
    }

    const abortController = new AbortController();
    state.currentAnswerAbort = abortController;

    try {
      this.send('answer-chunk', '📸 Capturing screen...\n\n');

      // Use Electron's desktopCapturer to get screen
      const { desktopCapturer } = require('electron');

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 }
      });

      if (sources.length === 0) {
        this.send('error', 'No screens found to capture');
        this.send('answer-done');
        return { ok: false };
      }

      // Get the first screen's thumbnail
      const screen = sources[0];
      const thumbnail = screen.thumbnail;
      const dataUrl = thumbnail.toDataURL();

      this.send('answer-chunk', `✓ Screen captured (${thumbnail.getSize().width}x${thumbnail.getSize().height})\n\n`);

      // Check for vision model
      const visionConfig = getVisionModel(this.config);

      if (!visionConfig) {
        this.send('answer-chunk', '**❌ No vision model available**\n\n');
        this.send('answer-chunk', 'Vision analysis requires an OpenAI or OpenRouter API key.\n\n');
        this.send('answer-chunk', 'Add one of these to your `api-keys.json`:\n');
        this.send('answer-chunk', '- OpenAI key (for GPT-4 Vision)\n');
        this.send('answer-chunk', '- OpenRouter key (for multiple vision models)\n');
        this.send('answer-done');
        return { ok: false };
      }

      this.send('answer-chunk', `🤖 Analyzing with ${visionConfig.model}...\n\n`);

      // Create provider and send vision request
      const provider = createProvider(visionConfig.provider, visionConfig.apiKey);

      // Build vision message - matching extension's format
      const userText = [
        "The interviewer is currently sharing the screen below.",
        "Use the screen content as the PRIMARY source of the question.",
        "",
        "Current question (ANSWER THIS based on what's visible on screen):",
        '"""',
        "Analyze the screen and provide a direct answer.",
        '"""',
        "",
        "Reply in the required Q:/A: format using short bullet points in plain English - no long paragraphs.",
        "Solve any visible problem (LeetCode, coding question, error, search query) DIRECTLY.",
        "If there is code on screen, explain or complete it.",
        "If there is a search query visible, answer that query with actual code/solution.",
        "DO NOT just describe what's on screen - SOLVE the problem shown.",
      ].join("\n");

      const messages = [
        {
          role: 'system',
          content: this.buildSystemPrompt()
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: userText
            },
            {
              type: 'image_url',
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ];

      // Stream response - with temperature 0.3
      try {
        const stream = provider.streamChat(messages, {
          model: visionConfig.model,
          temperature: 0.3,
          signal: abortController.signal,
        });

        for await (const chunk of stream) {
          this.send('answer-chunk', chunk);
        }

        this.send('answer-done');
        console.log('[backend] Vision analysis complete');
        return { ok: true };
      } catch (err) {
        // Fallback chain: try Gemini first, then Groq keys from 10th down to 5th
        const fallbackProviders = [];
        // Gemini fallback (if API key present)
        if (this.config.apiKeys && this.config.apiKeys.gemini && this.config.apiKeys.gemini.length > 0) {
          fallbackProviders.push({
            provider: 'gemini',
            model: 'gemini-3.5-flash',
            apiKey: this.config.apiKeys.gemini[0],
          });
        }
        // Groq fallback keys from 10th (index 9) down to 5th (index 4)
        const groqKeys = this.config.apiKeys && this.config.apiKeys.groq ? this.config.apiKeys.groq : [];
        for (let i = Math.min(9, groqKeys.length - 1); i >= 4; i--) {
          const key = groqKeys[i];
          if (key) {
            fallbackProviders.push({
              provider: 'groq',
              model: 'qwen/qwen3.6-27b',
              apiKey: key,
            });
          }
        }

        for (const fb of fallbackProviders) {
          try {
            console.warn(`[backend] Vision provider failed. Trying fallback: ${fb.provider} (model: ${fb.model})`);
            this.send('answer-chunk', `\n\n*⚠️ Vision provider fallback: ${fb.provider} (${fb.model})*\n\n`);
            const fallbackProvider = createProvider(fb.provider, fb.apiKey);
            const fallbackStream = fallbackProvider.streamChat(messages, {
              model: fb.model,
              temperature: 0.3,
              signal: abortController.signal,
            });
            for await (const chunk of fallbackStream) {
              this.send('answer-chunk', chunk);
            }
            this.send('answer-done');
            console.log(`[backend] Vision analysis complete via fallback ${fb.provider}`);
            return { ok: true };
          } catch (innerErr) {
            // If this fallback also fails, continue to next
            console.error(`[backend] Fallback ${fb.provider} failed:`, innerErr);
            // continue loop
          }
        }
        // If all fallbacks exhausted, rethrow original error
        throw err;
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[backend] Vision analysis aborted');
      } else {
        console.error('[backend] Vision analysis error:', error);
        const message = error instanceof LLMHttpError
          ? error.message
          : `Screen analysis failed: ${error.message}`;
        this.send('error', message);
        this.send('answer-done');
      }
      return { ok: false };
    } finally {
      state.currentAnswerAbort = null;
    }
  }

  async transcribeAudio(base64Wav) {
    try {
      // Decode base64 to Buffer (Node.js)
      const audioBuffer = Buffer.from(base64Wav, 'base64');

      // Use Groq Whisper for transcription
      const { default: fetch } = await import('node-fetch');
      const FormData = (await import('form-data')).default;

      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
      });
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      form.append('language', 'en');

      const apiKey = Array.isArray(this.config.apiKeys) ? this.config.apiKeys[0] : this.config.apiKey;

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: form,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Groq Whisper error: ${response.status} - ${error}`);
      }

      const result = await response.json();
      const text = result.text?.trim() || '';

      if (text && !isWhisperHallucination(text)) {
        // Add to transcript
        await this.addTranscript(text);
      } else if (text) {
        console.log('[backend] Discarded Whisper silence hallucination:', text);
      }

      return { ok: true, text };
    } catch (error) {
      console.error('[backend] Transcription error:', error);
      return { ok: false, error: error.message || String(error) };
    }
  }
}

module.exports = { Backend };
