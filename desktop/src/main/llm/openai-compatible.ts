import { createLogger } from '../logger';
import { LLMHttpError } from './errors';
import { readSseData, ThinkTagFilter } from './sse';
import type { ChatMessage, ChatProvider, StreamChatOptions } from './types';

export interface OpenAICompatibleOptions {
  /** Display name used in logs and errors. */
  name: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  defaultTemperature?: number;
  /** Request field that carries the output token limit. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Extra provider-specific body fields for a given model. */
  extraBody?: (model: string) => Record<string, unknown>;
  /** Strip `<think>` reasoning blocks emitted by some hosted reasoning models. */
  stripThinkTags?: boolean;
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null } }[];
}

/** Streaming client for any `/chat/completions` endpoint that speaks the OpenAI protocol. */
export class OpenAICompatibleProvider implements ChatProvider {
  private readonly log;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.log = createLogger(options.name);
  }

  async *streamChat(messages: ChatMessage[], { model, temperature, maxTokens, signal }: StreamChatOptions): AsyncGenerator<string> {
    const { name, baseUrl, apiKey, headers, defaultTemperature = 0.3, maxTokensField = 'max_tokens', extraBody } = this.options;

    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: temperature ?? defaultTemperature,
      stream: true,
      ...extraBody?.(model),
    };
    if (maxTokens) payload[maxTokensField] = maxTokens;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok || !response.body) {
      throw await LLMHttpError.fromResponse(response, name, model);
    }

    const thinkFilter = this.options.stripThinkTags ? new ThinkTagFilter() : null;

    for await (const data of readSseData(response.body)) {
      let delta: string | null | undefined;
      try {
        delta = (JSON.parse(data) as ChatCompletionChunk).choices?.[0]?.delta?.content;
      } catch (error) {
        this.log.warn('Skipping unparseable SSE event:', error);
        continue;
      }
      if (!delta) continue;

      const text = thinkFilter ? thinkFilter.push(delta) : delta;
      if (text) yield text;
    }

    const rest = thinkFilter?.flush();
    if (rest) yield rest;
  }
}
