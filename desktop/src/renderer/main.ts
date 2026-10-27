import type { SessionState } from '../shared/ipc';
import { SpeakerCapture } from './audio/speaker-capture';
import { renderMarkdown } from './lib/markdown';
import { type Elements, queryElements } from './ui/dom';
import { SessionTimer } from './ui/session-timer';
import { setupTransparencyControls } from './ui/transparency';

const ERROR_DISPLAY_MS = 5_000;

const api = window.electronAPI;

class App {
  private session: SessionState = { active: false, paused: false };
  private currentAnswer = '';
  private currentQuestion = '';
  /** True once the current answer has finished; the next chunk starts a fresh card. */
  private answerComplete = false;
  private errorTimeout: number | null = null;

  private readonly timer: SessionTimer;
  private readonly audio: SpeakerCapture;

  constructor(private readonly el: Elements) {
    this.timer = new SessionTimer(el.timer);
    this.audio = new SpeakerCapture(async (base64Wav) => {
      const result = await api.transcribeAudio(base64Wav);
      if (result.error) console.error('[audio] STT error:', result.error);
    });
  }

  async init(): Promise<void> {
    this.bindControls();
    this.bindIpcEvents();
    setupTransparencyControls(this.el.root, this.el.opacitySlider, this.el.opacityValue);
    this.render();

    try {
      await api.loadConfig();
    } catch (error) {
      this.showError(error);
    }
  }

  private bindControls(): void {
    const { el } = this;

    el.startBtn.addEventListener('click', () => void this.start());
    el.pauseBtn.addEventListener('click', () =>
      this.run(async () => {
        await this.audio.stop();
        await api.pauseSession();
      }),
    );
    el.resumeBtn.addEventListener('click', () =>
      this.run(async () => {
        await api.resumeSession();
        await this.audio.start();
      }),
    );
    el.exitBtn.addEventListener('click', () =>
      this.run(async () => {
        await this.audio.stop();
        await api.hideWindow(); // Also stops the session.
      }),
    );
    el.clearBtn.addEventListener('click', () =>
      this.run(async () => {
        await api.clearTranscript();
        this.clearAnswerCard();
      }),
    );

    el.answerBtn.addEventListener('click', () => this.run(() => api.generateAnswer()));
    el.analyseBtn.addEventListener('click', () => this.run(() => api.analyseScreen()));

    el.manualSend.addEventListener('click', () => void this.sendManualQuestion());
    el.manualInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.sendManualQuestion();
      }
    });

    el.closeCard.addEventListener('click', () => this.clearAnswerCard());
  }

  private bindIpcEvents(): void {
    api.onSessionState((state) => {
      this.session = state;
      if (state.active && !this.timer.running) {
        this.timer.start();
      } else if (!state.active) {
        this.timer.stop();
        // The session can end from the main process (hotkey hide), so release the audio too.
        if (this.audio.isCapturing) void this.audio.stop();
      }
      this.render();
    });

    api.onTranscriptUpdate(({ transcript, livePartial }) => {
      const last = transcript[transcript.length - 1];
      if (last) this.currentQuestion = last;
      this.el.live.textContent = livePartial;
    });

    api.onAnswerChunk((text) => {
      if (this.currentAnswer === '' || this.answerComplete) {
        this.currentAnswer = '';
        this.answerComplete = false;
        this.showAnswerCard();
      }
      this.currentAnswer += text;
      this.displayAnswer();
    });

    api.onAnswerDone(() => {
      this.answerComplete = true;
    });

    api.onError((message) => this.showError(message));
  }

  private async start(): Promise<void> {
    try {
      // Backend start and OS loopback negotiation are independent; run them together.
      const sessionStarted = api.startSession();
      this.showStatus('🎤 Starting audio capture...');
      await Promise.all([sessionStarted, this.audio.start()]);
      this.showStatus('✓ Audio capture started');
    } catch (error) {
      this.showError(error);
      await this.audio.stop().catch(() => undefined);
      await api.stopSession().catch(() => undefined);
    }
  }

  private async sendManualQuestion(): Promise<void> {
    const text = this.el.manualInput.value.trim();
    if (!text) return;

    try {
      if (!this.session.active) await api.startSession();
      this.currentQuestion = text;
      await api.addTranscript(text);
      this.el.manualInput.value = '';
    } catch (error) {
      this.showError(error);
    }
  }

  private render(): void {
    const { el } = this;
    const { active, paused } = this.session;
    const running = active && !paused;

    el.dot.className = 'ic-dot';
    if (active) el.dot.classList.add(paused ? 'paused' : 'active');
    el.status.textContent = !active ? 'Inactive' : paused ? 'Paused' : 'Active';

    el.startBtn.hidden = active;
    el.pauseBtn.hidden = !running;
    el.resumeBtn.hidden = !(active && paused);

    el.exitBtn.disabled = false;
    el.clearBtn.disabled = !active;
    el.answerBtn.disabled = !running;
    el.analyseBtn.disabled = !running;
  }

  private showAnswerCard(): void {
    const { el } = this;
    for (const node of [el.card, el.summary, el.heading]) node.removeAttribute('data-empty');
    el.questionText.textContent = this.currentQuestion || 'Question';
  }

  private clearAnswerCard(): void {
    const { el } = this;
    for (const node of [el.card, el.summary, el.heading]) node.setAttribute('data-empty', '1');
    el.body.innerHTML = '';
    this.currentAnswer = '';
    this.currentQuestion = '';
    this.answerComplete = false;
  }

  private displayAnswer(): void {
    // Safe: renderMarkdown escapes all model output before adding markup.
    this.el.body.innerHTML = renderMarkdown(this.currentAnswer);
    this.el.body.scrollTop = this.el.body.scrollHeight;
  }

  private showStatus(message: string): void {
    if (this.errorTimeout !== null) window.clearTimeout(this.errorTimeout);
    this.el.err.textContent = message;
    this.errorTimeout = window.setTimeout(() => {
      this.el.err.textContent = '';
      this.errorTimeout = null;
    }, ERROR_DISPLAY_MS);
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[renderer]', message);
    this.showStatus(message);
  }

  /** Runs a UI action and surfaces any failure in the status line. */
  private run(action: () => Promise<unknown>): void {
    action().catch((error: unknown) => this.showError(error));
  }
}

function boot(): void {
  void new App(queryElements()).init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
