// AudioWorklet processor used by offscreen.js.
//
// Loaded via `audioCtx.audioWorklet.addModule(chrome.runtime.getURL(...))`.
// The processor consumes the standard 128-sample-per-call render quanta and
// emits one Float32 frame to the main thread every `framesPerPost` samples
// (default 4096 = ~256 ms at 16 kHz, mirroring the old ScriptProcessor).
//
// Runs on the AudioWorkletGlobalScope thread - it has only AudioWorklet APIs.
// `registerProcessor`, `AudioWorkletProcessor`, `currentTime`, `sampleRate`
// are globals here.

class PCMTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._target = opts.framesPerPost || 4096;
    this._buf = new Float32Array(this._target);
    this._idx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;          // no input yet, keep node alive
    const ch = input[0];                            // mono channel 0
    let i = 0;
    while (i < ch.length) {
      const room = this._target - this._idx;
      const take = room < (ch.length - i) ? room : (ch.length - i);
      this._buf.set(ch.subarray(i, i + take), this._idx);
      this._idx += take;
      i += take;
      if (this._idx >= this._target) {
        // .slice() copies; original buffer continues filling on next call.
        this.port.postMessage(this._buf.slice(0, this._target));
        this._idx = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PCMTap);
