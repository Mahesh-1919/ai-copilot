import { describe, expect, it } from 'vitest';
import { readSseData, ThinkTagFilter } from '../src/main/llm/sse';

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSseData(stream)) out.push(data);
  return out;
}

describe('readSseData', () => {
  it('splits events across chunk boundaries and CRLF framing', async () => {
    expect(await collect(streamOf('data: {"a":', '1}\r\n\r\ndata: {"b":2}\n', ': comment\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('stops at [DONE]', async () => {
    expect(await collect(streamOf('data: one\ndata: [DONE]\ndata: two\n'))).toEqual(['one']);
  });

  it('yields a final event without a trailing newline', async () => {
    expect(await collect(streamOf('data: last'))).toEqual(['last']);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n');
    expect(await collect(streamOf(bytes.slice(0, 8), bytes.slice(8)))).toEqual(['héllo']);
  });
});

describe('ThinkTagFilter', () => {
  it('passes text through when there is no think block', () => {
    const filter = new ThinkTagFilter();
    expect(filter.push('Hello ')).toBe('Hello ');
    expect(filter.push('world')).toBe('world');
  });

  it('drops a think block streamed across deltas', () => {
    const filter = new ThinkTagFilter();
    expect(filter.push('<think>plan')).toBe('');
    expect(filter.push('ning</thi')).toBe('');
    expect(filter.push('nk>  Answer')).toBe('Answer');
    expect(filter.push(' more')).toBe(' more');
    expect(filter.flush()).toBe('');
  });

  it('discards an unterminated think block on flush', () => {
    const filter = new ThinkTagFilter();
    filter.push('<think>never closed');
    expect(filter.flush()).toBe('');
  });
});
