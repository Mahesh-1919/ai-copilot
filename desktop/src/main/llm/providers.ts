import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openai-compatible';
import type { ChatProvider, ProviderName } from './types';

export function createProvider(provider: ProviderName, apiKey: string): ChatProvider {
  switch (provider) {
    case 'cerebras':
      return new OpenAICompatibleProvider({
        name: 'Cerebras',
        baseUrl: 'https://api.cerebras.ai/v1',
        apiKey,
        headers: { 'X-Cerebras-Version-Patch': '2' },
        defaultTemperature: 0.2,
        maxTokensField: 'max_completion_tokens',
        extraBody: (model) => (model === 'gpt-oss-120b' ? { reasoning_effort: 'low' } : {}),
      });
    case 'groq':
      return new OpenAICompatibleProvider({
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey,
        stripThinkTags: true,
      });
    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey,
      });
    case 'openrouter':
      return new OpenAICompatibleProvider({
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey,
        headers: { 'HTTP-Referer': 'https://system-monitor', 'X-Title': 'System Monitor' },
      });
    case 'gemini':
      return new GeminiProvider(apiKey);
  }
}
