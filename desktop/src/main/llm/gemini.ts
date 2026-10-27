import { createLogger } from '../logger';
import { LLMHttpError } from './errors';
import { readSseData } from './sse';
import type { ChatMessage, ChatProvider, StreamChatOptions } from './types';

const log = createLogger('Gemini');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MAX_OUTPUT_TOKENS = 900;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiStreamChunk {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/**
 * Converts OpenAI-style messages to Gemini `contents`. Gemini only knows the
 * `user` and `model` roles, so system prompts are sent as a user turn.
 */
export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (typeof message.content === 'string') {
      parts.push({ text: message.content });
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else {
          const dataUrl = part.image_url.url;
          const data = dataUrl.includes('base64,') ? (dataUrl.split('base64,')[1] ?? '') : dataUrl;
          const mimeType = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
          parts.push({ inlineData: { mimeType, data } });
        }
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

export class GeminiProvider implements ChatProvider {
  constructor(private readonly apiKey: string) {}

  // Temperature is deliberately not forwarded: Gemini 3 models are tuned for their default.
  async *streamChat(messages: ChatMessage[], { model, maxTokens, signal }: StreamChatOptions): AsyncGenerator<string> {
    const payload = {
      contents: toGeminiContents(messages),
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        maxOutputTokens: maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    };

    // The key goes in a header rather than the query string so it can't leak into URL logs.
    const response = await fetch(`${BASE_URL}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok || !response.body) {
      throw await LLMHttpError.fromResponse(response, 'Gemini', model);
    }

    for await (const data of readSseData(response.body)) {
      try {
        const chunk = JSON.parse(data) as GeminiStreamChunk;
        const text = chunk.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
        if (text) yield text;
      } catch (error) {
        log.warn('Skipping unparseable SSE event:', error);
      }
    }
  }
}
