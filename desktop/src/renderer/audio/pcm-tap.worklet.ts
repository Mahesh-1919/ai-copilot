// AudioWorklet processor: collects 128-sample render quanta and posts one
// Float32Array frame to the main thread every `framesPerPost` samples
// (default 4096 ≈ 256 ms at 16 kHz). Runs in AudioWorkletGlobalScope.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor): void;

// Must match PCM_TAP_PROCESSOR in speaker-capture.ts. This file is built as its own
// bundle and must not be imported by page code, so the name can't be shared.
const PCM_TAP_PROCESSOR = 'pcm-tap';

interface PcmTapOptions {
  framesPerPost?: number;
}

class PcmTapProcessor extends AudioWorkletProcessor {
  private readonly target: number;
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super();
    const opts = (options?.processorOptions ?? {}) as PcmTapOptions;
    this.target = opts.framesPerPost ?? 4096;
    this.buffer = new Float32Array(this.target);
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true; // No input yet; keep the node alive.

    let i = 0;
    while (i < channel.length) {
      const take = Math.min(this.target - this.index, channel.length - i);
      this.buffer.set(channel.subarray(i, i + take), this.index);
      this.index += take;
      i += take;
      if (this.index >= this.target) {
        this.port.postMessage(this.buffer.slice(0, this.target));
        this.index = 0;
      }
    }
    return true;
  }
}

registerProcessor(PCM_TAP_PROCESSOR, PcmTapProcessor);
