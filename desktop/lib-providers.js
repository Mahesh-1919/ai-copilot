// LLM providers adapted for Node.js/Electron
const fetch = require('node-fetch');

const SSE_LINE = /^data:\s*(.*)$/;

// Strip <think>...</think> reasoning blocks emitted by Groq thinking models
function stripThinkTags(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trimStart();
}

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

// ─── Groq provider ────────────────────────────────────────────────────────────
class GroqProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1';
  }

  async *streamChat(messages, { model, temperature = 0.3, max_tokens, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = { model, messages, temperature, stream: true };
    if (max_tokens) payload.max_tokens = max_tokens;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({ status: response.status, provider: 'Groq', model, body: text, retryAfterHeader: response.headers.get('retry-after') });
    }

    const reader = response.body;
    let buffer = '';
    let thinkBuffer = ''; // accumulate <think>…</think> across chunks

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
          let delta = json.choices?.[0]?.delta?.content;
          if (!delta) continue;

          // Buffer and strip <think> reasoning blocks
          thinkBuffer += delta;
          // Once we've seen the closing tag, flush everything after it
          const closeIdx = thinkBuffer.indexOf('</think>');
          if (closeIdx !== -1) {
            const after = thinkBuffer.slice(closeIdx + '</think>'.length).trimStart();
            thinkBuffer = '';
            if (after) yield after;
          } else if (!thinkBuffer.includes('<think>')) {
            // No think tag at all - yield immediately
            yield thinkBuffer;
            thinkBuffer = '';
          }
          // else: inside <think> block, keep buffering
        } catch (e) {
          console.error('[Groq] Parse error:', e);
        }
      }
    }
    // Flush any remaining non-think content
    if (thinkBuffer && !thinkBuffer.includes('<think>')) {
      yield thinkBuffer;
    }
  }
}

// ─── OpenAI provider ──────────────────────────────────────────────────────────
class OpenAIProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.openai.com/v1';
  }

  async *streamChat(messages, { model, temperature = 0.3, max_tokens, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = { model, messages, temperature, stream: true };
    if (max_tokens) payload.max_tokens = max_tokens;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({ status: response.status, provider: 'OpenAI', model, body: text, retryAfterHeader: response.headers.get('retry-after') });
    }

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

// ─── OpenRouter provider ──────────────────────────────────────────────────────
class OpenRouterProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  async *streamChat(messages, { model, temperature = 0.3, max_tokens, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = { model, messages, temperature, stream: true };
    if (max_tokens) payload.max_tokens = max_tokens;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://system-monitor',
        'X-Title': 'System Monitor',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({ status: response.status, provider: 'OpenRouter', model, body: text, retryAfterHeader: response.headers.get('retry-after') });
    }

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

// ─── Gemini provider ──────────────────────────────────────────────────────────
class GeminiProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  // Convert the generic OpenAI-style messages array into Gemini's content format.
  // Gemini does not support a "system" role; prepend it as a user turn.
  _formatMessages(messages) {
    const contents = [];
    for (const m of messages) {
      // Flatten role: Gemini only supports "user" and "model"
      const role = m.role === 'assistant' ? 'model' : 'user';

      // Build parts array
      const parts = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image_url') {
            const dataUrl = part.image_url.url || '';
            const base64 = dataUrl.includes('base64,') ? dataUrl.split('base64,')[1] : dataUrl;
            const mimeType = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
            parts.push({ inlineData: { mimeType, data: base64 } });
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }
    return contents;
  }

  async *streamChat(messages, { model, temperature = 0.3, signal }) {
    const url = `${this.baseUrl}/${model}:generateContent?key=${this.apiKey}`;
    const contents = this._formatMessages(messages);

    const payload = {
      contents,
      generationConfig: { temperature },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMHttpError({ status: response.status, provider: 'Gemini', model, body: text, retryAfterHeader: response.headers.get('retry-after') });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text) yield text;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
function createProvider(providerName, apiKey) {
  switch (providerName.toLowerCase()) {
    case 'groq': return new GroqProvider(apiKey);
    case 'openai': return new OpenAIProvider(apiKey);
    case 'openrouter': return new OpenRouterProvider(apiKey);
    case 'gemini': return new GeminiProvider(apiKey);
    default: throw new Error(`Unknown provider: ${providerName}`);
  }
}

// ─── Vision model helpers ─────────────────────────────────────────────────────
function getVisionModel(config) {
  const { apiKeys = {} } = config;

  if (apiKeys.openai && apiKeys.openai.length > 0) {
    return {
      provider: 'openai',
      apiKey: Array.isArray(apiKeys.openai) ? apiKeys.openai[0] : apiKeys.openai,
      model: 'gpt-4o',
    };
  }

  if (apiKeys.openrouter && apiKeys.openrouter.length > 0) {
    return {
      provider: 'openrouter',
      apiKey: Array.isArray(apiKeys.openrouter) ? apiKeys.openrouter[0] : apiKeys.openrouter,
      model: 'openai/gpt-4o',
    };
  }

  if (apiKeys.gemini && apiKeys.gemini.length > 0) {
    return {
      provider: 'gemini',
      apiKey: Array.isArray(apiKeys.gemini) ? apiKeys.gemini[0] : apiKeys.gemini,
      model: 'gemini-3.5-flash',
    };
  }

  return null;
}

module.exports = {
  LLMHttpError,
  createProvider,
  getVisionModel,
};
