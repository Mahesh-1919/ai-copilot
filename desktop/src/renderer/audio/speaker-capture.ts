// Captures speaker/system audio (never the microphone), segments it into
// utterances with a simple energy-based VAD, and hands each one off as a WAV.

import { arrayBufferToBase64, encodeWav, mergeFrames, rms } from './wav';

const PCM_TAP_PROCESSOR = 'pcm-tap';
// Emitted by the build next to index.html; see scripts/build.mjs.
const WORKLET_URL = 'pcm-tap.worklet.js';

export interface VadSettings {
  /** Trailing silence that ends an utterance. */
  silenceMs: number;
  /** Utterances shorter than this are held until more audio arrives. */
  minChunkMs: number;
  /** Force-send continuous speech after this long. */
  maxChunkMs: number;
  /** RMS level below which a frame counts as silence. */
  silenceRms: number;
  sampleRate: number;
}

export const DEFAULT_VAD: VadSettings = {
  silenceMs: 900,
  minChunkMs: 500,
  maxChunkMs: 10_000,
  silenceRms: 0.01,
  sampleRate: 16_000,
};

const MIC_LABEL = /(microphone|headset mic|\bmic\b|webcam|camera audio)/i;

/** Receives each finished utterance as base64-encoded WAV. */
export type UtteranceHandler = (base64Wav: string) => Promise<void>;

export class SpeakerCapture {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;

  private capturing = false;
  private sending = false;
  private frames: Float32Array[] = [];
  private chunkStart = 0;
  private silenceStart: number | null = null;
  private speechDetected = false;

  constructor(
    private readonly onUtterance: UtteranceHandler,
    private readonly vad: VadSettings = DEFAULT_VAD,
  ) {}

  get isCapturing(): boolean {
    return this.capturing;
  }

  async start(): Promise<void> {
    if (this.capturing) throw new Error('Already capturing');

    try {
      // Chromium requires video for getDisplayMedia; the main process grants
      // audio as 'loopback' (speaker output). getUserMedia is never used.
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 16, height: 16, frameRate: 1 },
        audio: true,
        systemAudio: 'include',
        preferCurrentTab: false,
      } as DisplayMediaStreamOptions);

      for (const track of this.mediaStream.getVideoTracks()) {
        track.stop();
        this.mediaStream.removeTrack(track);
      }
      for (const track of this.mediaStream.getAudioTracks()) {
        if (MIC_LABEL.test(track.label)) {
          console.warn('[audio] Rejecting microphone track:', track.label);
          track.stop();
          this.mediaStream.removeTrack(track);
        }
      }

      const [audioTrack] = this.mediaStream.getAudioTracks();
      if (!audioTrack) {
        throw new Error('No speaker/system audio track. Microphone is blocked — use call audio from speakers/headphones.');
      }
      console.info('[audio] Capturing speakers:', audioTrack.label);

      this.audioContext = new AudioContext({ sampleRate: this.vad.sampleRate });
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      await this.audioContext.audioWorklet.addModule(WORKLET_URL);

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, PCM_TAP_PROCESSOR);
      // Keep the worklet in an active graph without playing loopback audio back out (no echo).
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
      this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => this.handleFrame(event.data);

      this.resetSegment();
      this.capturing = true;
    } catch (error) {
      await this.stop();
      const message = error instanceof Error ? error.message : String(error);
      const unsupported = (error instanceof Error && error.name === 'NotSupportedError') || /not supported/i.test(message);
      throw new Error(unsupported ? 'Audio capture not supported — restart the app after update' : message, {
        cause: error,
      });
    }
  }

  async stop(): Promise<void> {
    this.capturing = false;
    if (this.frames.length > 0) await this.flush().catch(() => undefined);

    if (this.workletNode) this.workletNode.port.onmessage = null;
    for (const node of [this.workletNode, this.silentGain, this.sourceNode]) {
      try {
        node?.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.workletNode = null;
    this.silentGain = null;
    this.sourceNode = null;

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    await this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.frames = [];
  }

  private handleFrame(samples: Float32Array): void {
    if (!this.capturing) return;

    const now = Date.now();
    const silent = rms(samples) < this.vad.silenceRms;
    this.frames.push(samples);

    if (!silent) {
      this.speechDetected = true;
      this.silenceStart = null;
    } else if (this.speechDetected && this.silenceStart === null) {
      this.silenceStart = now;
    }

    const elapsed = now - this.chunkStart;
    const pauseEnded = this.silenceStart !== null && now - this.silenceStart >= this.vad.silenceMs;
    const tooLong = elapsed >= this.vad.maxChunkMs;

    if (this.speechDetected && (pauseEnded || tooLong) && elapsed >= this.vad.minChunkMs) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.frames.length === 0 || this.sending) return;
    this.sending = true;

    const samples = mergeFrames(this.frames);
    this.resetSegment();

    try {
      await this.onUtterance(arrayBufferToBase64(encodeWav(samples, this.vad.sampleRate)));
    } catch (error) {
      console.error('[audio] Failed to hand off utterance:', error);
    } finally {
      this.sending = false;
    }
  }

  private resetSegment(): void {
    this.frames = [];
    this.silenceStart = null;
    this.speechDetected = false;
    this.chunkStart = Date.now();
  }
}
