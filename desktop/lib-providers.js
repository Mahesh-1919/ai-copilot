// LLM providers adapted for Node.js/Electron
const fetch = require('node-fetch');

const SSE_LINE = /^data:\s*(.*)$/;

class LLMHttpError extends Error {
  constructor({ status, provider, model, body, retryAfterHeader }) {
    super(`${provider} HTTP ${status}: ${(body || "").slice(0, 300)}`);
    this.name = "LLMHttpError";
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.body = body || "";
    this.retryAfterHeader = retryAfterHeader || "";
  }

  isRetryable() {
    if (this.status === 429 || this.status === 408) return true;
    if (this.status >= 500 && this.status < 600) return true;
    if (this.status === 0) return true;
    return false;
  }

  isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

// Groq provider
class GroqProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1';
  }

  async *streamChat(messages, { model, temperature = 0.7, max_tokens, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const payload = {
      model,
      messages,
      temperature,
      stream: true,
    };
    if (max_tokens) payload.max_tokens = max_tokens;

    const body = JSON.stringify(payload);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({
        status: response.status,
        provider: 'Groq',
        model,
        body: text,
        retryAfterHeader: response.headers.get('retry-after'),
      });
    }

    // Parse SSE stream
    const reader = response.body;
    let buffer = '';

    for await (const chunk of reader) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const match = SSE_LINE.exec(line.trim());
        if (!match) continue;
        const data = match[1];
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (e) {
          console.error('[Groq] Parse error:', e);
        }
      }
    }
  }
}

// OpenAI provider (supports vision)
class OpenAIProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.openai.com/v1';
  }

  async *streamChat(messages, { model, temperature = 0.7, max_tokens = 2000, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const body = JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
      max_tokens,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({
        status: response.status,
        provider: 'OpenAI',
        model,
        body: text,
        retryAfterHeader: response.headers.get('retry-after'),
      });
    }

    // Parse SSE stream
    const reader = response.body;
    let buffer = '';

    for await (const chunk of reader) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const match = SSE_LINE.exec(line.trim());
        if (!match) continue;
        const data = match[1];
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (e) {
          console.error('[OpenAI] Parse error:', e);
        }
      }
    }
  }
}

// OpenRouter provider (supports many vision models)
class OpenRouterProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  async *streamChat(messages, { model, temperature = 0.7, max_tokens = 2000, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://system-monitor',
      'X-Title': 'System Monitor',
    };

    const body = JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
      max_tokens,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({
        status: response.status,
        provider: 'OpenRouter',
        model,
        body: text,
        retryAfterHeader: response.headers.get('retry-after'),
      });
    }

    // Parse SSE stream
    const reader = response.body;
    let buffer = '';

    for await (const chunk of reader) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const match = SSE_LINE.exec(line.trim());
        if (!match) continue;
        const data = match[1];
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (e) {
          console.error('[OpenRouter] Parse error:', e);
        }
      }
    }
  }
}

// Factory function
function createProvider(providerName, apiKey) {
  switch (providerName.toLowerCase()) {
    case 'groq':
      return new GroqProvider(apiKey);
    case 'openai':
      return new OpenAIProvider(apiKey);
    case 'openrouter':
      return new OpenRouterProvider(apiKey);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

// Vision model helpers
function getVisionModel(config) {
  // Try to get a vision-capable model
  const visionModels = {
    openai: 'gpt-4o', // or gpt-4-vision-preview
    openrouter: 'openai/gpt-4o', // or google/gemini-pro-vision
  };

  if (config.apiKeys.openai && config.apiKeys.openai.length > 0) {
    return {
      provider: 'openai',
      apiKey: Array.isArray(config.apiKeys.openai) ? config.apiKeys.openai[0] : config.apiKeys.openai,
      model: visionModels.openai,
    };
  }

  if (config.apiKeys.openrouter && config.apiKeys.openrouter.length > 0) {
    return {
      provider: 'openrouter',
      apiKey: Array.isArray(config.apiKeys.openrouter) ? config.apiKeys.openrouter[0] : config.apiKeys.openrouter,
      model: visionModels.openrouter,
    };
  }

  return null;
}

module.exports = {
  LLMHttpError,
  createProvider,
  getVisionModel,
};
