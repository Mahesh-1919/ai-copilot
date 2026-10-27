import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64, encodeWav, mergeFrames, rms } from '../src/renderer/audio/wav';

describe('wav helpers', () => {
  it('merges frames in order', () => {
    expect(Array.from(mergeFrames([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });

  it('computes RMS', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
  });

  it('writes a valid 16-bit mono PCM header and clamps samples', () => {
    const buffer = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(buffer);
    const tag = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));

    expect(buffer.byteLength).toBe(44 + 8);
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 0x7fff, -0x8000, 0x7fff]);
  });

  it('base64-encodes like Buffer does', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
