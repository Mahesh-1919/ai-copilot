import { Models } from '../llm/candidates';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const REQUEST_TIMEOUT_MS = 30_000;

interface WhisperResponse {
  text?: string;
}

/** Sends a WAV clip to Groq Whisper and returns the trimmed transcript. */
export async function transcribeWithGroq(audio: Buffer, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', Models.transcription);
  form.append('response_format', 'json');
  form.append('language', 'en');

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Whisper error: ${response.status} - ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as WhisperResponse;
  return result.text?.trim() ?? '';
}
