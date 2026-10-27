const SSE_DATA_LINE = /^data:\s*(.*)$/;

/**
 * Yields the payload of every `data:` line in a Server-Sent Events stream.
 * Handles LF and CRLF framing, multi-byte characters split across chunks,
 * and a final event that isn't newline-terminated. Stops at `[DONE]`.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = done ? '' : (lines.pop() ?? '');

      for (const line of lines) {
        const match = SSE_DATA_LINE.exec(line.trim());
        if (!match) continue;
        const data = match[1] ?? '';
        if (data === '[DONE]') return;
        if (data) yield data;
      }

      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Removes `<think>...</think>` reasoning blocks from a token stream.
 * Text is held back while a think block is open and released once it closes.
 */
export class ThinkTagFilter {
  private pending = '';

  push(delta: string): string {
    this.pending += delta;

    const closeIdx = this.pending.indexOf('</think>');
    if (closeIdx !== -1) {
      const after = this.pending.slice(closeIdx + '</think>'.length).trimStart();
      this.pending = '';
      return after;
    }

    if (!this.pending.includes('<think>')) {
      const out = this.pending;
      this.pending = '';
      return out;
    }

    return '';
  }

  flush(): string {
    const out = this.pending.includes('<think>') ? '' : this.pending;
    this.pending = '';
    return out;
  }
}
