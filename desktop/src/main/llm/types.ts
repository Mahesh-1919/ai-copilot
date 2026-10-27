export type ProviderName = 'cerebras' | 'groq' | 'openai' | 'openrouter' | 'gemini';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface StreamChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatProvider {
  streamChat(messages: ChatMessage[], options: StreamChatOptions): AsyncGenerator<string>;
}

/** A concrete provider + key + model combination to try, in fallback order. */
export interface ModelCandidate {
  provider: ProviderName;
  apiKey: string;
  model: string;
}
