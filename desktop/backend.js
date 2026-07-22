// Backend logic - state management, LLM streaming, STT coordination
// Similar to background.js from extension, but adapted for Electron

const fs = require('fs').promises;
const path = require('path');
const { createProvider, getVisionModel, LLMHttpError } = require('./lib-providers');

const state = {
  active: false,
  transcript: [],
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
        } catch {}
      }

      // Try to load job description
      let jobDescription = '';
      for (const filename of ['job-description.txt', 'jd.txt', 'jd.md', 'job-description.md']) {
        try {
          jobDescription = await fs.readFile(path.join(rootDir, filename), 'utf-8');
          break;
        } catch {}
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

  async addTranscript(text) {
    if (!state.active || state.paused) {
      return { ok: false };
    }

    state.transcript.push(text);
    this.send('transcript-update', {
      transcript: state.transcript,
      livePartial: state.livePartial,
    });

    // Auto-answer with short debounce (matches snappy extension feel)
    if (this.config?.autoAnswer && !state.paused) {
      if (this._autoAnswerTimer) clearTimeout(this._autoAnswerTimer);
      this._autoAnswerTimer = setTimeout(() => {
        this._autoAnswerTimer = null;
        this.generateAnswer().catch((e) => {
          console.error('[backend] auto-answer failed:', e);
        });
      }, 350);
    }

    return { ok: true };
  }

  async clearTranscript() {
    state.transcript = [];
    state.livePartial = "";
    state.consumedTurnIdx = 0;
    
    this.send('transcript-update', {
      transcript: [],
      livePartial: "",
    });
    
    return { ok: true };
  }

  async generateAnswer(override) {
    if (!state.active) {
      this.send('error', 'No active session');
      return { ok: false };
    }

    // Abort any in-flight answer
    if (state.currentAnswerAbort) {
      state.currentAnswerAbort.abort();
    }

    const abortController = new AbortController();
    state.currentAnswerAbort = abortController;

    try {
      // Build the question from unconsumed transcript
      const question = state.transcript.slice(state.consumedTurnIdx).join(' ').trim();
      
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
      
      // Build messages — keep user turn short for lower TTFT
      const messages = [
        { role: 'system', content: this.buildSystemPrompt() },
        {
          role: 'user',
          content: `Current question (answer ONLY this):\n"""${question}"""\n\nReply Q:/A: with 3-5 short bullets. Start immediately.`,
        },
      ];

      // Stream response — lower temp + max_tokens = faster finish
      const stream = provider.streamChat(messages, {
        model: this.config.model,
        temperature: 0.35,
        max_tokens: 450,
        signal: abortController.signal,
      });

      for await (const chunk of stream) {
        this.send('answer-chunk', chunk);
      }

      this.send('answer-done');

      // Mark this question as consumed
      state.consumedTurnIdx = state.transcript.length;

      console.log('[backend] Answer complete');
      return { ok: true };

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

      // Stream response
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

      if (text) {
        // Add to transcript
        await this.addTranscript(text);
      }

      return { ok: true, text };
    } catch (error) {
      console.error('[backend] Transcription error:', error);
      return { ok: false, error: error.message || String(error) };
    }
  }
}

module.exports = { Backend };
