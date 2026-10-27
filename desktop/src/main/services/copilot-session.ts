import type { ConfigSummary, EventChannel, EventPayloadArgs, OkResult, TranscriptionResult } from '../../shared/ipc';
import { IpcEvent } from '../../shared/ipc';
import { answerCandidates, screenAnswerCandidates, visionExtractionCandidates } from '../llm/candidates';
import { errorMessage, isAbortError } from '../llm/errors';
import { createProvider } from '../llm/providers';
import type { ChatMessage, ModelCandidate, StreamChatOptions } from '../llm/types';
import { createLogger } from '../logger';
import { type AppConfig, loadConfig, summariseConfig } from './config';
import {
  SCREEN_CONTEXT_PREAMBLE,
  buildSystemPrompt,
  currentQuestionPrompt,
  screenExtractionPrompt,
  screenSolutionPrompt,
} from './prompts';
import { isValidQuestion, isWhisperHallucination, looksIncomplete } from './question-heuristics';
import { transcribeWithGroq } from './transcription';

const log = createLogger('session');

const AUTO_ANSWER_DELAY_MS = 1_000;
const AUTO_ANSWER_DELAY_INCOMPLETE_MS = 2_500;
const HISTORY_LIMIT = 5;
const HISTORY_TURNS_IN_PROMPT = 3;
const HISTORY_ANSWER_CHARS = 600;
const SCREEN_CONTEXT_CHARS = 12_000;
const ANSWER_MAX_TOKENS = 650;
const ANSWER_MAX_TOKENS_CODE = 1_800;
const EXTRACTION_MAX_TOKENS = 2_400;
const SCREEN_ANSWER_MAX_TOKENS = 3_500;

const WANTS_FULL_CODE = /\b(code|implement|implementation|runnable|complete solution|full solution|no mocks?)\b/i;
const MENTIONS_SCREEN = /\b(screen|screenshot|shown|visible)\b/i;

export type EmitFn = <C extends EventChannel>(channel: C, ...payload: EventPayloadArgs<C>) => void;

export interface ScreenCapture {
  dataUrl: string;
  width: number;
  height: number;
}

export interface CopilotSessionDeps {
  emit: EmitFn;
  /** Directories searched (in order) for api-keys.json, resume and job description. */
  configDirs: readonly string[];
  captureScreen: () => Promise<ScreenCapture>;
}

interface HistoryTurn {
  question: string;
  answer: string;
}

/**
 * Owns one interview session: the transcript, answer history, auto-answer
 * debounce and in-flight model requests. All renderer actions route here.
 */
export class CopilotSession {
  private config: AppConfig | null = null;

  private active = false;
  private paused = false;
  private transcript: string[] = [];
  private history: HistoryTurn[] = [];
  /** Latest screen-analysis result, kept so follow-up questions stay on the same task. */
  private screenContext = '';
  private livePartial = '';
  /** Transcript entries before this index have already been answered. */
  private consumedTurnIdx = 0;

  private currentRequest: AbortController | null = null;
  private autoAnswerTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CopilotSessionDeps) {}

  async loadConfig(): Promise<ConfigSummary> {
    this.config = await loadConfig(this.deps.configDirs);
    return summariseConfig(this.config);
  }

  async startSession(): Promise<OkResult> {
    // Fast Start/Stop/Start must never error, so always tear down what's left.
    if (this.active || this.paused || this.currentRequest || this.autoAnswerTimer) {
      log.debug('Ending previous session before start');
      this.stopSession();
    }

    // Reload on every start so edits to keys/resume/JD apply without restarting the app.
    await this.loadConfig();

    this.resetConversation();
    this.active = true;
    this.paused = false;
    this.emitSessionState();
    log.info('Session started');
    return { ok: true };
  }

  stopSession(): OkResult {
    this.cancelInFlight();
    this.resetConversation();
    this.active = false;
    this.paused = false;
    this.emitSessionState();
    log.info('Session stopped');
    return { ok: true };
  }

  pauseSession(): OkResult {
    this.paused = true;
    this.clearAutoAnswerTimer();
    this.emitSessionState();
    return { ok: true };
  }

  resumeSession(): OkResult {
    this.paused = false;
    this.emitSessionState();
    return { ok: true };
  }

  addTranscript(text: string): OkResult {
    if (!this.active || this.paused) return { ok: false };

    this.transcript.push(text);
    this.emitTranscript();
    this.scheduleAutoAnswer();
    return { ok: true };
  }

  clearTranscript(): OkResult {
    this.resetConversation();
    this.emitTranscript();
    return { ok: true };
  }

  abortAnswer(): OkResult {
    this.currentRequest?.abort();
    this.currentRequest = null;
    return { ok: true };
  }

  async generateAnswer(override?: string): Promise<OkResult> {
    if (!this.active) {
      this.emitError('No active session');
      return { ok: false };
    }

    const fromOverride = typeof override === 'string' && override.trim() !== '';
    const question = fromOverride ? override.trim() : this.pendingQuestion();
    if (!question) {
      this.emitError('No question to answer');
      return { ok: false };
    }

    // A text-only model can't answer "what's on screen", so capture it the first time it's asked about.
    if (!this.screenContext && MENTIONS_SCREEN.test(question)) {
      if (!fromOverride) this.consumedTurnIdx = this.transcript.length;
      return this.analyseScreen(question);
    }

    const candidates = answerCandidates(this.config?.apiKeys ?? {});
    if (candidates.length === 0) {
      this.emitError('No API key configured. Add api-keys.json in the config folder.');
      return { ok: false };
    }

    const controller = this.beginRequest();
    try {
      log.info('Generating answer for:', question.slice(0, 100));
      const { text, candidate } = await this.streamFirstSuccessful(candidates, this.buildAnswerMessages(question), {
        temperature: 0.2,
        maxTokens: WANTS_FULL_CODE.test(question) ? ANSWER_MAX_TOKENS_CODE : ANSWER_MAX_TOKENS,
        signal: controller.signal,
      });

      this.deps.emit(IpcEvent.AnswerDone);
      this.history.push({ question, answer: text });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      if (!fromOverride) this.consumedTurnIdx = this.transcript.length;
      log.info(`Answer complete via ${candidate.provider}`);
      return { ok: true };
    } catch (error) {
      if (isAbortError(error)) {
        log.debug('Answer generation aborted');
      } else {
        log.error('Error generating answer:', error);
        this.emitError(errorMessage(error));
      }
      return { ok: false };
    } finally {
      this.endRequest(controller);
    }
  }

  async analyseScreen(instruction = ''): Promise<OkResult> {
    if (!this.active) {
      this.emitError('No active session');
      return { ok: false };
    }

    const keys = this.config?.apiKeys ?? {};
    const controller = this.beginRequest();
    try {
      this.emitChunk('📸 Capturing screen...\n\n');
      const screen = await this.deps.captureScreen();
      this.emitChunk(`✓ Screen captured (${screen.width}x${screen.height})\n\n`);
      this.emitChunk('👁 Reading the screen with Gemma...\n\n');

      const extracted = await this.collectFirstSuccessful(
        visionExtractionCandidates(keys),
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: screenExtractionPrompt(instruction) },
              { type: 'image_url', image_url: { url: screen.dataUrl } },
            ],
          },
        ],
        { temperature: 0.1, maxTokens: EXTRACTION_MAX_TOKENS, signal: controller.signal },
      );

      this.emitChunk('🧠 Solving with gpt-oss-120b...\n\n');

      const solution = await this.streamFirstSuccessful(
        screenAnswerCandidates(keys),
        [
          { role: 'system', content: this.systemPrompt() },
          { role: 'user', content: screenSolutionPrompt(extracted, instruction) },
        ],
        { temperature: 0.2, maxTokens: SCREEN_ANSWER_MAX_TOKENS, signal: controller.signal },
        { requireText: true },
      );

      this.screenContext = ['Extracted screen task:', extracted, '', 'Latest solution:', solution.text].join('\n');
      this.deps.emit(IpcEvent.AnswerDone);
      log.info(`Screen solved via ${solution.candidate.model}`);
      return { ok: true };
    } catch (error) {
      if (!isAbortError(error)) {
        log.error('Screen pipeline error:', error);
        this.emitError(`Screen analysis failed: ${errorMessage(error)}`);
        this.deps.emit(IpcEvent.AnswerDone);
      }
      return { ok: false };
    } finally {
      this.endRequest(controller);
    }
  }

  async transcribeAudio(base64Wav: string): Promise<TranscriptionResult> {
    try {
      // Speech-to-text always uses Groq Whisper; answer keys are never sent here.
      const apiKey = this.config?.apiKeys.groq?.[0];
      if (!apiKey) throw new Error('No Groq key configured for Whisper transcription');

      const text = await transcribeWithGroq(Buffer.from(base64Wav, 'base64'), apiKey);
      if (text && !isWhisperHallucination(text)) {
        this.addTranscript(text);
      } else if (text) {
        log.debug('Discarded Whisper silence hallucination:', text);
      }
      return { ok: true, text };
    } catch (error) {
      log.error('Transcription error:', error);
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** Cancels timers and in-flight requests; used when the window is hidden or the app quits. */
  dispose(): void {
    this.cancelInFlight();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private pendingQuestion(): string {
    return this.transcript.slice(this.consumedTurnIdx).join(' ').trim();
  }

  private systemPrompt(): string {
    return buildSystemPrompt(this.config?.resume ?? '', this.config?.jobDescription ?? '');
  }

  private buildAnswerMessages(question: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: this.systemPrompt() }];

    // A few recent turns give multi-turn context while keeping time-to-first-token low.
    for (const turn of this.history.slice(-HISTORY_TURNS_IN_PROMPT)) {
      messages.push({ role: 'user', content: `Question: ${turn.question}` });
      messages.push({ role: 'assistant', content: `Answer Summary:\n${turn.answer.slice(0, HISTORY_ANSWER_CHARS)}` });
    }

    if (this.screenContext) {
      messages.push({ role: 'user', content: SCREEN_CONTEXT_PREAMBLE });
      messages.push({ role: 'assistant', content: this.screenContext.slice(0, SCREEN_CONTEXT_CHARS) });
    }

    messages.push({ role: 'user', content: currentQuestionPrompt(question) });
    return messages;
  }

  private scheduleAutoAnswer(): void {
    if (!this.config?.autoAnswer || this.paused || !this.active) return;

    const question = this.pendingQuestion();
    if (!question) return;

    const incomplete = looksIncomplete(question);
    const waitMs = incomplete ? AUTO_ANSWER_DELAY_INCOMPLETE_MS : AUTO_ANSWER_DELAY_MS;
    log.debug(`Auto-answer in ${waitMs}ms${incomplete ? ' (looks incomplete)' : ''}: "${question.slice(-30)}"`);

    this.clearAutoAnswerTimer();
    this.autoAnswerTimer = setTimeout(() => {
      this.autoAnswerTimer = null;
      const current = this.pendingQuestion();
      if (!isValidQuestion(current)) {
        log.debug(`Auto-answer skipped; not a complete question: "${current}"`);
        return;
      }
      void this.generateAnswer();
    }, waitMs);
  }

  /** Streams from each candidate in turn until one succeeds; chunks go straight to the renderer. */
  private async streamFirstSuccessful(
    candidates: ModelCandidate[],
    messages: ChatMessage[],
    options: Omit<StreamChatOptions, 'model'>,
    { requireText = false } = {},
  ): Promise<{ text: string; candidate: ModelCandidate }> {
    let lastError: unknown;
    for (const [index, candidate] of candidates.entries()) {
      try {
        let text = '';
        const stream = createProvider(candidate.provider, candidate.apiKey).streamChat(messages, {
          ...options,
          model: candidate.model,
        });
        for await (const chunk of stream) {
          text += chunk;
          this.emitChunk(chunk);
        }
        if (requireText && !text.trim()) throw new Error(`${candidate.model} returned an empty response`);
        return { text: text.trim(), candidate };
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        log.warn(`${candidate.provider}/${candidate.model} attempt ${index + 1} failed; trying fallback:`, errorMessage(error));
      }
    }
    throw lastError ?? new Error('No model provider configured');
  }

  /** Like `streamFirstSuccessful` but buffers the full text instead of streaming it to the UI. */
  private async collectFirstSuccessful(
    candidates: ModelCandidate[],
    messages: ChatMessage[],
    options: Omit<StreamChatOptions, 'model'>,
  ): Promise<string> {
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        let text = '';
        const stream = createProvider(candidate.provider, candidate.apiKey).streamChat(messages, {
          ...options,
          model: candidate.model,
        });
        for await (const chunk of stream) text += chunk;
        if (!text.trim()) throw new Error(`${candidate.model} returned an empty response`);
        return text.trim();
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        log.warn(`${candidate.model} failed; trying next screen pipeline candidate:`, errorMessage(error));
      }
    }
    throw lastError ?? new Error('No screen-analysis provider configured');
  }

  /** Aborts any in-flight request and returns a controller for the new one. */
  private beginRequest(): AbortController {
    this.clearAutoAnswerTimer();
    this.currentRequest?.abort();
    const controller = new AbortController();
    this.currentRequest = controller;
    return controller;
  }

  private endRequest(controller: AbortController): void {
    // Only clear if a newer request hasn't already replaced this one.
    if (this.currentRequest === controller) this.currentRequest = null;
  }

  private cancelInFlight(): void {
    this.currentRequest?.abort();
    this.currentRequest = null;
    this.clearAutoAnswerTimer();
  }

  private clearAutoAnswerTimer(): void {
    if (this.autoAnswerTimer) {
      clearTimeout(this.autoAnswerTimer);
      this.autoAnswerTimer = null;
    }
  }

  private resetConversation(): void {
    this.transcript = [];
    this.history = [];
    this.screenContext = '';
    this.livePartial = '';
    this.consumedTurnIdx = 0;
  }

  private emitSessionState(): void {
    this.deps.emit(IpcEvent.SessionState, { active: this.active, paused: this.paused });
  }

  private emitTranscript(): void {
    this.deps.emit(IpcEvent.TranscriptUpdate, { transcript: [...this.transcript], livePartial: this.livePartial });
  }

  private emitChunk(text: string): void {
    this.deps.emit(IpcEvent.AnswerChunk, text);
  }

  private emitError(message: string): void {
    this.deps.emit(IpcEvent.Error, message);
  }
}
