import type { ApiKeys } from '../services/config';
import type { ModelCandidate, ProviderName } from './types';

export const Models = {
  answer: 'gpt-oss-120b',
  vision: 'gemma-4-31b',
  gemini: 'gemini-3.5-flash-lite',
  openRouterAnswer: 'openai/gpt-oss-120b',
  openRouterVision: 'google/gemini-2.5-flash',
  transcription: 'whisper-large-v3-turbo',
} as const;

/*
 * Cerebras key slots have fixed roles:
 *   cerebras[0] - primary text answers
 *   cerebras[1] - screen analysis (vision extraction + solving)
 *   cerebras[2] - shared fallback for both
 * Gemini and OpenRouter (first key each) are the final fallbacks.
 */

type Slot = [provider: ProviderName & keyof ApiKeys, keyIndex: number, model: string];

function resolve(keys: ApiKeys, slots: Slot[]): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];
  for (const [provider, keyIndex, model] of slots) {
    const apiKey = keys[provider]?.[keyIndex];
    if (apiKey) candidates.push({ provider, apiKey, model });
  }
  return candidates;
}

/** Text answers to transcript / typed questions. */
export function answerCandidates(keys: ApiKeys): ModelCandidate[] {
  return resolve(keys, [
    ['cerebras', 0, Models.answer],
    ['cerebras', 2, Models.answer],
    ['gemini', 0, Models.gemini],
    ['openrouter', 0, Models.openRouterAnswer],
  ]);
}

/** Stage 1 of screen analysis: a vision model transcribes the screenshot. */
export function visionExtractionCandidates(keys: ApiKeys): ModelCandidate[] {
  return resolve(keys, [
    ['cerebras', 1, Models.vision],
    ['cerebras', 2, Models.vision],
    ['gemini', 0, Models.gemini],
    ['openrouter', 0, Models.openRouterVision],
  ]);
}

/** Stage 2 of screen analysis: a reasoning model solves the extracted task. */
export function screenAnswerCandidates(keys: ApiKeys): ModelCandidate[] {
  return resolve(keys, [
    ['cerebras', 1, Models.answer],
    ['cerebras', 2, Models.answer],
    ['gemini', 0, Models.gemini],
    ['openrouter', 0, Models.openRouterAnswer],
  ]);
}
