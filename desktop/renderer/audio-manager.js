// Audio capture and STT for desktop app
// Uses getDisplayMedia + Electron loopback (system audio on Windows)

class AudioManager {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.silentGain = null;
    this.isCapturing = false;
    this.audioBuffer = [];
    this.silenceStart = null;
    this.chunkStart = Date.now();
    this.speakingDetected = false;
    this.sending = false;

    // VAD settings — tuned for faster STT turnaround (closer to extension)
    this.SILENCE_MS = 900;
    this.MIN_CHUNK_MS = 500;
    this.MAX_CHUNK_MS = 10000;
    this.SILENCE_RMS = 0.01;
    this.TARGET_SAMPLE_RATE = 16000;
  }

  isMicrophoneTrack(track) {
    const label = (track.label || '').toLowerCase();
    // Explicit mic labels — reject these
    if (/(microphone|headset mic|\bmic\b|webcam|camera audio)/i.test(label)) {
      return true;
    }
    // System/speaker loopback labels — keep
    if (/(loopback|system|stereo mix|what u hear|wave out|speaker|desktop|display|screen)/i.test(label)) {
      return false;
    }
    return false;
  }

  async start() {
    if (this.isCapturing) {
      throw new Error('Already capturing');
    }

    try {
      console.log('[audio] Requesting SPEAKER loopback only (not microphone)...');

      // Chromium requires video:true. Main process grants audio:'loopback' (speakers).
      // systemAudio:'include' asks for OS output; never call getUserMedia({audio:true}).
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 16, height: 16, frameRate: 1 },
        audio: true,
        systemAudio: 'include',
        // Prefer not sharing tab/mic hybrids when the browser supports it
        preferCurrentTab: false,
      });

      // Drop video immediately — we only need speaker audio
      for (const track of this.mediaStream.getVideoTracks()) {
        track.stop();
        this.mediaStream.removeTrack(track);
      }

      // Strip any microphone tracks if Chromium attached one
      for (const track of this.mediaStream.getAudioTracks()) {
        const label = track.label || '(unnamed)';
        if (this.isMicrophoneTrack(track)) {
          console.warn('[audio] Rejecting microphone track:', label);
          track.stop();
          this.mediaStream.removeTrack(track);
        } else {
          console.log('[audio] Keeping speaker/system track:', label);
        }
      }

      const audioTracks = this.mediaStream.getAudioTracks();
      if (!audioTracks.length) {
        throw new Error('No speaker/system audio track. Microphone is blocked — use call audio from speakers/headphones.');
      }
      console.log('[audio] Capturing speakers only:', audioTracks[0].label);

      this.audioContext = new AudioContext({ sampleRate: this.TARGET_SAMPLE_RATE });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      await this.audioContext.audioWorklet.addModule('audio-worklet.js');
      console.log('[audio] Audio worklet loaded');

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-tap');

      // Keep worklet in active graph without playing loopback back out (avoids echo)
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);

      this.workletNode.port.onmessage = (event) => {
        this.handleAudioFrame(event.data);
      };

      this.isCapturing = true;
      this.chunkStart = Date.now();
      this.audioBuffer = [];
      this.silenceStart = null;
      this.speakingDetected = false;
      console.log('[audio] Capture started successfully');

      return { ok: true };
    } catch (error) {
      console.error('[audio] Error starting capture:', error);
      await this.stop();
      const msg = error?.name === 'NotSupportedError' || /not supported/i.test(error?.message || '')
        ? 'Audio capture not supported — restart the app after update'
        : (error.message || String(error));
      throw new Error(msg);
    }
  }

  handleAudioFrame(samples) {
    if (!this.isCapturing) return;

    const rms = Math.sqrt(samples.reduce((sum, val) => sum + val * val, 0) / samples.length);
    const isSilence = rms < this.SILENCE_RMS;
    const now = Date.now();
    const elapsedFromChunk = now - this.chunkStart;

    this.audioBuffer.push(samples);

    if (!isSilence) {
      this.speakingDetected = true;
      this.silenceStart = null;
    } else if (this.speakingDetected && !this.silenceStart) {
      this.silenceStart = now;
    }

    const shouldSend =
      (this.speakingDetected && this.silenceStart && (now - this.silenceStart) >= this.SILENCE_MS) ||
      (this.speakingDetected && elapsedFromChunk >= this.MAX_CHUNK_MS);

    if (shouldSend && this.audioBuffer.length > 0 && elapsedFromChunk >= this.MIN_CHUNK_MS) {
      this.sendChunk();
    }
  }

  async sendChunk() {
    if (this.audioBuffer.length === 0 || this.sending) return;
    this.sending = true;

    const totalLength = this.audioBuffer.reduce((sum, arr) => sum + arr.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const arr of this.audioBuffer) {
      merged.set(arr, offset);
      offset += arr.length;
    }

    this.audioBuffer = [];
    this.silenceStart = null;
    this.chunkStart = Date.now();
    this.speakingDetected = false;

    const wavBlob = this.float32ToWav(merged, this.TARGET_SAMPLE_RATE);
    console.log(`[audio] Sending chunk: ${(merged.length / this.TARGET_SAMPLE_RATE).toFixed(2)}s, ${(wavBlob.size / 1024).toFixed(1)}KB`);

    try {
      const arrayBuffer = await wavBlob.arrayBuffer();
      const base64 = this.arrayBufferToBase64(arrayBuffer);
      const result = await window.electronAPI.transcribeAudio(base64);
      if (result?.text?.trim()) {
        console.log('[audio] Transcribed:', result.text);
      } else if (result?.error) {
        console.error('[audio] STT error:', result.error);
      }
    } catch (error) {
      console.error('[audio] Transcription error:', error);
    } finally {
      this.sending = false;
    }
  }

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  async stop() {
    console.log('[audio] Stopping capture...');
    this.isCapturing = false;

    if (this.audioBuffer.length > 0) {
      try { await this.sendChunk(); } catch {}
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try { this.workletNode.disconnect(); } catch {}
      this.workletNode = null;
    }

    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch {}
      this.silentGain = null;
    }

    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch {}
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      try { await this.audioContext.close(); } catch {}
      this.audioContext = null;
    }

    this.audioBuffer = [];
    console.log('[audio] Capture stopped');
    return { ok: true };
  }
}

window.audioManager = new AudioManager();
