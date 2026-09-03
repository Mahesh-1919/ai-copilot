// Backend logic - state management, LLM streaming, STT coordination
// Similar to background.js from extension, but adapted for Electron

const fs = require('fs').promises;
const path = require('path');
const { createProvider, LLMHttpError } = require('./lib-providers');

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
  screenContext: "", // Latest screen solution retained for follow-up questions
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
        provider: 'cerebras',
        apiKey: getFirstKey(apiKeys.cerebras),
        model: 'gpt-oss-120b',
        sttProvider: 'groq',
        sttModel: 'whisper-large-v3-turbo',
        autoAnswer: true,
      };

      console.log('[backend] Config loaded:', {
        hasPrimaryAnswerKey: !!this.config.apiKey,
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
      "You are an interview copilot. Write an answer the candidate can understand quickly and say naturally.",
      "",
      "REQUIRED STYLE:",
      "- Use simple, everyday English. Prefer short sentences.",
      "- Answer the question directly in the first sentence.",
      "- Give only the details needed to explain the idea clearly.",
      "- Use 3-5 short bullets. Each bullet should express one idea.",
      "- Use an everyday analogy or practical example when it makes the idea easier to remember.",
      "- Use technical terms only when necessary, and explain each term immediately in plain English.",
      "- Sound conversational, like a person speaking in an interview—not a textbook or documentation page.",
      "- Never add unrelated technologies, deployment details, tools, or buzzwords just to sound technical.",
      "- Do not repeat the same definition in different words.",
      "- The user's latest instruction always overrides earlier answers, examples, defaults, and preparation-guide suggestions.",
      "- Never choose mocks, fake agents, hard-coded model responses, or placeholder data unless the user explicitly asks for them.",
      "- If the user says 'no mocks', provide a real model-backed implementation and keep it connected to the original task.",
      "",
      "FORMAT FOR CONCEPT OR TECHNICAL QUESTIONS:",
      "Q: <short question>",
      "A:",
      "- <one-sentence direct answer>",
      "- <simple explanation of how it works>",
      "- <practical example or analogy, when useful>",
      "- <important use case or trade-off, only if relevant>",
      "",
      "EXAMPLE:",
      "Q: What is an AI agent?",
      "A:",
      "- An AI agent is a program that can understand a goal, decide what to do, and take actions to complete it.",
      "- It usually follows a loop: observe what is happening, choose the next step, act, and check the result.",
      "- Think of it like a digital assistant that can not only answer questions but also use tools to finish a task.",
      "- For example, a travel agent could search flights, compare prices, and prepare a booking for approval.",
      "",
      "COMPARISON QUESTIONS:",
      "- State the main difference first.",
      "- Explain when each option is useful with one simple example.",
      "- Mention a trade-off only when it matters to the question.",
      "",
      "ARCHITECTURE OR HOW-IT-WORKS QUESTIONS:",
      "- Explain the flow in order: input, main steps, output.",
      "- Name components only when they are important, and explain their purpose simply.",
      "- If asked to draw, include a small readable ASCII diagram.",
      "",
      "CODING QUESTIONS:",
      "- Start with the approach and why it fits.",
      "- Give clean code when requested.",
      "- Explain time and space complexity in plain English.",
      "- If asked for an implementation, provide complete runnable code that satisfies every stated requirement—not a generic wrapper or architecture sketch.",
      "- For revisions and follow-ups, modify the existing solution instead of replacing it with an unrelated example.",
      "",
      "BEHAVIORAL OR PAST-EXPERIENCE QUESTIONS:",
      "- Always use STAR: Situation, Task, Action, Result.",
      "- Situation: one short line of context.",
      "- Task: the responsibility or problem.",
      "- Action: the specific steps I personally took.",
      "- Result: the measurable outcome or lesson.",
      "- Use resume facts when available. Never invent achievements or numbers.",
      "",
      "SCENARIO QUESTIONS:",
      "- Explain what I would do in a clear step-by-step order.",
      "- State assumptions briefly and focus on practical actions.",
      "",
      "AVOID:",
      "- Long paragraphs",
      "- Jargon-heavy definitions",
      "- Unexplained acronyms",
      "- Irrelevant examples or tools",
      "- Generic phrases such as 'flexibility and scalability' without explaining how",
    ].join("\n");

    if (resume) {
      prompt += [
        "",
        "---",
        "CANDIDATE RESUME:",
        "Use this for experience and behavioral answers. Do not invent facts, metrics, or projects.",
        resume.slice(0, 12000),
      ].join("\n");
    }

    if (jobDescription) {
      const guideMatch = /interview\s*prep(?:aration)?\s*guide(?:\s*[-—:]\s*[^\r\n]*)?/i.exec(jobDescription);
      const roleDetails = guideMatch
        ? jobDescription.slice(0, guideMatch.index).trim()
        : jobDescription.trim();
      const prepGuide = guideMatch
        ? jobDescription.slice(guideMatch.index + guideMatch[0].length).trim()
        : "";

      prompt += [
        "",
        "---",
        "TARGET ROLE AND JOB DESCRIPTION:",
        roleDetails.slice(0, 10000),
      ].join("\n");

      if (prepGuide) {
        prompt += [
          "",
          "---",
          "HIGH-PRIORITY INTERVIEW PREPARATION GUIDE FROM HR:",
          "Treat these topics and evaluation signals as especially important when answering relevant questions.",
          "Use the guide to choose depth, terminology, design concerns, and likely follow-up points.",
          "Do NOT copy or reuse the guide's sample scenarios, especially its animal/zoo examples.",
          "Create fresh, realistic examples relevant to enterprise AI, software engineering, cloud systems, or the candidate's experience.",
          "Do not force guide topics into unrelated answers.",
          prepGuide.slice(0, 14000),
        ].join("\n");
      }
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
    state.screenContext = "";
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
    state.screenContext = "";
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
    state.screenContext = "";
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

  getAnswerCandidates() {
    const keys = this.config?.apiKeys || {};
    const first = (value) => Array.isArray(value) ? value[0] : value;
    const candidates = [];
    if (keys.cerebras?.[0]) candidates.push({ provider: 'cerebras', apiKey: keys.cerebras[0], model: 'gpt-oss-120b' });
    // The second Cerebras key is reserved for the requested image role. GPT-OSS
    // is text-only, so actual screenshots use a vision-capable provider below.
    if (keys.cerebras?.[2]) candidates.push({ provider: 'cerebras', apiKey: keys.cerebras[2], model: 'gpt-oss-120b' });
    if (first(keys.gemini)) candidates.push({ provider: 'gemini', apiKey: first(keys.gemini), model: 'gemini-3.5-flash-lite' });
    if (first(keys.openrouter)) candidates.push({ provider: 'openrouter', apiKey: first(keys.openrouter), model: 'openai/gpt-oss-120b' });
    return candidates;
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

      // A text-only model cannot answer "what is shown on screen". Capture the
      // screen automatically the first time such a request is detected.
      if (!state.screenContext && /\b(screen|screenshot|shown|visible)\b/i.test(question)) {
        if (typeof override !== 'string') state.consumedTurnIdx = state.transcript.length;
        return await this.analyseScreen(question);
      }

      // Check if we have API key
      if (!this.config || !this.config.apiKey) {
        this.send('error', 'No API key configured. Add api-keys.json in root folder.');
        return { ok: false };
      }

      console.log('[backend] Generating answer for:', question.substring(0, 100));

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

      // Bridge the latest vision result into later audio/manual follow-ups.
      if (state.screenContext) {
        messages.push({
          role: 'user',
          content: 'Context from the latest Analyse Screen result. Keep follow-up answers tied to this same assignment:',
        });
        messages.push({
          role: 'assistant',
          content: state.screenContext.slice(0, 12000),
        });
      }

      // Add current user question
      messages.push({
        role: 'user',
        content: `Current question (answer ONLY this while preserving relevant screen and conversation context):\n"""${question}"""\n\nThe latest user instruction overrides conflicting earlier answers or guide examples. If code is requested, return a complete task-specific implementation. Use the clearest format for the request; do not force short bullets when full code is needed. Start immediately.`,
      });

      const candidates = this.getAnswerCandidates();
      const wantsFullCode = /\b(code|implement|implementation|runnable|complete solution|full solution|no mocks?)\b/i.test(question);
      let lastError;
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        let fullAnswer = "";
        try {
          const stream = createProvider(candidate.provider, candidate.apiKey).streamChat(messages, {
            model: candidate.model,
            temperature: 0.2,
            max_tokens: wantsFullCode ? 1800 : 650,
            signal: abortController.signal,
          });
          for await (const chunk of stream) {
            fullAnswer += chunk;
            this.send('answer-chunk', chunk);
          }
          this.send('answer-done');
          state.history.push({ question, answer: fullAnswer.trim() });
          if (state.history.length > 5) state.history.shift();
          if (typeof override !== 'string') state.consumedTurnIdx = state.transcript.length;
          console.log(`[backend] Answer complete via ${candidate.provider}`);
          return { ok: true };
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          lastError = error;
          console.warn(`[backend] ${candidate.provider} answer attempt ${index + 1} failed; trying fallback`);
        }
      }
      throw lastError || new Error('No answer provider configured');

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

  getVisionExtractionCandidates() {
    const keys = this.config?.apiKeys || {};
    const first = (value) => Array.isArray(value) ? value[0] : value;
    return [
      keys.cerebras?.[1] && { provider: 'cerebras', model: 'gemma-4-31b', apiKey: keys.cerebras[1] },
      keys.cerebras?.[2] && { provider: 'cerebras', model: 'gemma-4-31b', apiKey: keys.cerebras[2] },
      first(keys.gemini) && { provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: first(keys.gemini) },
      first(keys.openrouter) && { provider: 'openrouter', model: 'google/gemini-2.5-flash', apiKey: first(keys.openrouter) },
    ].filter(Boolean);
  }

  getScreenAnswerCandidates() {
    const keys = this.config?.apiKeys || {};
    const first = (value) => Array.isArray(value) ? value[0] : value;
    return [
      keys.cerebras?.[1] && { provider: 'cerebras', model: 'gpt-oss-120b', apiKey: keys.cerebras[1] },
      keys.cerebras?.[2] && { provider: 'cerebras', model: 'gpt-oss-120b', apiKey: keys.cerebras[2] },
      first(keys.gemini) && { provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: first(keys.gemini) },
      first(keys.openrouter) && { provider: 'openrouter', model: 'openai/gpt-oss-120b', apiKey: first(keys.openrouter) },
    ].filter(Boolean);
  }

  async collectFromCandidates(candidates, messages, options) {
    let lastError;
    for (const candidate of candidates) {
      try {
        let text = '';
        const stream = createProvider(candidate.provider, candidate.apiKey).streamChat(messages, {
          model: candidate.model,
          ...options,
        });
        for await (const chunk of stream) text += chunk;
        if (!text.trim()) throw new Error(`${candidate.model} returned an empty response`);
        return { text: text.trim(), candidate };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        lastError = error;
        console.warn(`[backend] ${candidate.model} failed; trying next screen pipeline candidate`);
      }
    }
    throw lastError || new Error('No screen-analysis provider configured');
  }

  async analyseScreen(screenInstruction = '') {
    if (!state.active) {
      this.send('error', 'No active session');
      return { ok: false };
    }

    const abortController = new AbortController();
    state.currentAnswerAbort = abortController;

    try {
      this.send('answer-chunk', '📸 Capturing screen...\n\n');
      const { desktopCapturer } = require('electron');
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 960, height: 540 },
      });
      if (!sources.length) throw new Error('No screens found to capture');

      const thumbnail = sources[0].thumbnail;
      const dataUrl = thumbnail.toDataURL();
      const size = thumbnail.getSize();
      this.send('answer-chunk', `✓ Screen captured (${size.width}x${size.height})\n\n`);
      this.send('answer-chunk', '👁 Reading the screen with Gemma...\n\n');

      // Stage 1: vision models only extract the task. They do not design or code.
      const extractionPrompt = [
        'Read the screenshot carefully. Do NOT solve the task.',
        'Extract all information needed by a separate coding/reasoning model.',
        'Preserve exact names, numbers, constraints, functional requirements, non-functional requirements, acceptance criteria, edge cases, requested output format, and visible code.',
        'Distinguish mandatory requirements from examples or optional guidance.',
        screenInstruction ? `The user specifically asked: ${screenInstruction}` : '',
        'Return a clear structured text transcription. Do not add assumptions.',
      ].filter(Boolean).join('\n');

      const extractionMessages = [{
        role: 'user',
        content: [
          { type: 'text', text: extractionPrompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }];
      const extracted = await this.collectFromCandidates(
        this.getVisionExtractionCandidates(),
        extractionMessages,
        { temperature: 0.1, max_tokens: 2400, signal: abortController.signal },
      );

      this.send('answer-chunk', `🧠 Solving with gpt-oss-120b...\n\n`);

      // Stage 2: a stronger text/coding model reasons over Gemma's transcription.
      const solutionMessages = [
        { role: 'system', content: this.buildSystemPrompt() },
        {
          role: 'user',
          content: [
            'Solve the screen task below. The extracted screen text is the source of truth.',
            screenInstruction ? `User instruction: ${screenInstruction}` : '',
            'If implementation is requested, provide complete runnable task-specific code with clear simple comments, validation, error handling, entrypoint, and meaningful tests.',
            'Do not use mocks, fake agents, hard-coded LLM outputs, placeholder data, or an unrelated generic SDK wrapper unless the task explicitly requires mocks.',
            'Honor every acceptance criterion. Do not introduce deployment or cloud architecture unless requested.',
            '',
            'EXTRACTED SCREEN TEXT:',
            extracted.text,
          ].filter(Boolean).join('\n'),
        },
      ];

      let lastError;
      for (const candidate of this.getScreenAnswerCandidates()) {
        try {
          let fullAnswer = '';
          const stream = createProvider(candidate.provider, candidate.apiKey).streamChat(solutionMessages, {
            model: candidate.model,
            temperature: 0.2,
            max_tokens: 3500,
            signal: abortController.signal,
          });
          for await (const chunk of stream) {
            fullAnswer += chunk;
            this.send('answer-chunk', chunk);
          }
          if (!fullAnswer.trim()) throw new Error(`${candidate.model} returned an empty response`);
          state.screenContext = [
            'Extracted screen task:',
            extracted.text,
            '',
            'Latest solution:',
            fullAnswer.trim(),
          ].join('\n');
          this.send('answer-done');
          console.log(`[backend] Screen solved via ${candidate.model}`);
          return { ok: true };
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          lastError = error;
          console.warn(`[backend] ${candidate.model} solution failed; trying fallback`);
        }
      }
      throw lastError || new Error('No screen-answer provider configured');
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('[backend] Screen pipeline error:', error);
        this.send('error', `Screen analysis failed: ${error.message || error}`);
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

      // Speech-to-text still uses Groq Whisper; do not pass the Cerebras answer key.
      const groqKeys = this.config.apiKeys?.groq;
      const apiKey = Array.isArray(groqKeys) ? groqKeys[0] : groqKeys;
      if (!apiKey) throw new Error('No Groq key configured for Whisper transcription');

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
