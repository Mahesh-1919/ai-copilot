export interface LLMHttpErrorInit {
  status: number;
  provider: string;
  model: string;
  body?: string;
  retryAfterHeader?: string | null;
}

export class LLMHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly model: string;
  readonly body: string;
  readonly retryAfterHeader: string;

  constructor({ status, provider, model, body = '', retryAfterHeader }: LLMHttpErrorInit) {
    super(`${provider} HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'LLMHttpError';
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.body = body;
    this.retryAfterHeader = retryAfterHeader ?? '';
  }

  isRetryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || (this.status >= 500 && this.status < 600);
  }

  isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  static async fromResponse(response: Response, provider: string, model: string): Promise<LLMHttpError> {
    return new LLMHttpError({
      status: response.status,
      provider,
      model,
      body: await response.text().catch(() => ''),
      retryAfterHeader: response.headers.get('retry-after'),
    });
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
